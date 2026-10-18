import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  emitAppError,
  executeMsg,
  questionKeys,
  setupDeduplicationId,
  setupGroupId,
  TEST_COUNTS,
  type ExecuteSetupMsg,
  type QuestionItem,
} from '@yulove/shared';
import { questionsDb } from '@yulove/shared/server';
import { z } from 'zod';
import { createGeminiClient, type GeminiClient } from '../lib/gemini.js';
import { extractSection, loadPromptFile, renderPrompt } from '../lib/prompt.js';
import {
  GENERATE_RESPONSE_SCHEMA,
  GenerationError,
  parseGenerated,
  parseRegenerated,
  REGENERATE_RESPONSE_SCHEMA,
} from '../lib/responses.js';
import { GeminiBusyError, withRetries } from '../lib/retry.js';
import { getGeminiApiKey, requireEnv } from '../lib/secret.js';

/**
 * Times Gemini may be asked to replace failing inputs before the question is marked
 * GENERATION_FAILED. Counted since the last full generation, so a teacher's retry starts again.
 */
export const MAX_REGENERATION_ROUNDS = 2;

const eventSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('generate'),
    questionId: z.string().min(1),
    version: z.number().int().positive(),
    attempt: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal('regenerate'),
    questionId: z.string().min(1),
    version: z.number().int().positive(),
    /** The round whose reference-solution run failed. */
    attempt: z.number().int().positive(),
    /** Positions 0-6 (small) and 7-9 (large) to replace. */
    indexes: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(TEST_COUNTS.total - 1),
      )
      .min(1),
    reason: z.string().optional(),
  }),
]);

export type TestGenEvent = z.infer<typeof eventSchema>;

/** A Gemini call that has not answered after this long is given up on. */
export const GEMINI_CALL_TIMEOUT_MS = 150_000;
const SAFETY_MARGIN_MS = 10_000;
/** Retries inside one invocation, for 429, 5xx and timeouts. */
const IN_CALL_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Times a round may end because Gemini is busy (429, 5xx, timeouts that outlast the retries in
 * one invocation) before it is marked GENERATION_FAILED. Between tries the handler throws, and
 * Lambda's asynchronous retries (two, about a minute and two minutes later) run it again.
 */
export const MAX_BUSY_TRIES = 3;
export const BUSY_REASON = 'Gemini is busy right now, try generating again';

export type TestGenOutcome =
  | { outcome: 'sent'; attempt: number }
  | { outcome: 'stale' }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'failed'; reason: string };

export interface Deps {
  /** For tests: replace the waits between retries. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** A Gemini client; the real one reads the API key from Secrets Manager (cached). */
  gemini(): Promise<GeminiClient>;
  /** The prompt file's text. */
  prompt(): string;
}

const defaultDeps: Deps = {
  async gemini() {
    return createGeminiClient(await getGeminiApiKey());
  },
  prompt: () => loadPromptFile(),
};

/**
 * One Gemini call with retries for 429, 5xx and timeouts. Google's requested delay is honoured
 * when it fits in the time left. A call that is still failing for those reasons is "busy": it
 * throws GeminiBusyError. Any other error is thrown as it is.
 */
async function askGemini(
  gemini: GeminiClient,
  request: Parameters<GeminiClient['generateJson']>[0],
  deps: Deps,
  remainingMs: () => number,
): Promise<string> {
  const result = await withRetries(
    () => gemini.generateJson({ ...request, timeoutMs: GEMINI_CALL_TIMEOUT_MS }),
    {
      retries: IN_CALL_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      remainingMs,
      attemptBudgetMs: GEMINI_CALL_TIMEOUT_MS + SAFETY_MARGIN_MS,
      onAttempt: (info) =>
        console.error(`Gemini call ${info.call} failed: ${String((info.error as Error)?.message)}`),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
    },
  );
  if (result.value !== undefined) return result.value;
  if (result.fatal) throw result.error;
  throw new GeminiBusyError(
    `Gemini is busy: ${String((result.error as Error)?.message ?? result.error)}`,
    result.googleDelayMs,
  );
}

const asText = (value: unknown) => JSON.stringify(value, null, 2);

function questionValues(q: QuestionItem): Record<string, string> {
  return {
    title: q.title,
    statement: q.statement,
    ioDescription: q.ioDescription,
    constraints: q.constraints,
    examples: q.examples
      .map((e, i) => `Example ${i + 1}\nInput: ${e.input}\nOutput: ${e.output}`)
      .join('\n\n'),
    targetComplexity: q.targetComplexity,
    timeLimitMs: String(q.timeLimitMs),
    memoryMb: String(q.memoryMb),
    compareMode: q.compareMode,
  };
}

function model(): string {
  const value = process.env['GEMINI_MODEL'];
  if (!value || value.startsWith('<')) {
    throw new GenerationError('The Gemini model is not configured (geminiModel in infra/cdk.json)');
  }
  return value;
}

/** Makes an error message safe to store and show: no API key, at most 300 characters. */
function describe(error: unknown, secrets: string[]): string {
  let text =
    error instanceof GenerationError
      ? error.message
      : `Gemini request failed: ${String(error instanceof Error ? error.message : error)}`;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

async function putText(key: string, body: string): Promise<void> {
  await new S3Client({}).send(
    new PutObjectCommand({ Bucket: requireEnv('BUCKET_NAME'), Key: key, Body: body }),
  );
}

async function getText(key: string): Promise<string> {
  const out = await new S3Client({}).send(
    new GetObjectCommand({ Bucket: requireEnv('BUCKET_NAME'), Key: key }),
  );
  return (await out.Body?.transformToString('utf8')) ?? '';
}

async function sendSetup(message: ExecuteSetupMsg): Promise<void> {
  const body = executeMsg.parse(message);
  await new SQSClient({}).send(
    new SendMessageCommand({
      QueueUrl: requireEnv('EXECUTE_QUEUE_URL'),
      MessageBody: JSON.stringify(body),
      MessageGroupId: setupGroupId(message.questionId),
      MessageDeduplicationId: setupDeduplicationId(
        message.questionId,
        message.version,
        message.attempt,
      ),
    }),
  );
}

function setupMessage(q: QuestionItem, attempt: number, smallInputs: string[]): ExecuteSetupMsg {
  const keys = questionKeys(q.questionId, q.version);
  return {
    type: 'SETUP',
    questionId: q.questionId,
    version: q.version,
    attempt,
    referenceKey: keys.reference,
    generatorKey: keys.generator,
    smallInputs,
    largeInputCount: TEST_COUNTS.large,
    testsKey: keys.tests,
    timeLimitMs: q.timeLimitMs,
    memoryMb: q.memoryMb,
    compareMode: q.compareMode,
  };
}

/** Tracks which generation round the failure handler should close. */
interface RoundState {
  attempt: number;
}

async function runGenerate(
  event: Extract<TestGenEvent, { mode: 'generate' }>,
  deps: Deps,
  round: RoundState,
  remainingMs: () => number,
): Promise<TestGenOutcome> {
  const q = await questionsDb.getQuestion(event.questionId, event.version);
  if (!q) return { outcome: 'ignored', reason: 'question not found' };
  if (q.testAttempt !== event.attempt) return { outcome: 'stale' };

  const modelName = model();
  const prompt = renderPrompt(extractSection(deps.prompt(), 'generate'), questionValues(q));
  const gemini = await deps.gemini();
  const generated = parseGenerated(
    await askGemini(
      gemini,
      { model: modelName, prompt, schema: GENERATE_RESPONSE_SCHEMA },
      deps,
      remainingMs,
    ),
  );

  // Claim the round before writing files, so a replaced round cannot overwrite a newer one's files.
  const saved = await questionsDb.saveSignature(
    q.questionId,
    q.version,
    event.attempt,
    generated.signature,
  );
  if (saved === 'stale') return { outcome: 'stale' };

  const keys = questionKeys(q.questionId, q.version);
  await putText(keys.reference, generated.referenceSolution);
  await putText(keys.generator, generated.generatorScript);
  await putText(keys.smallInputs, JSON.stringify(generated.smallInputs));
  await sendSetup(setupMessage(q, event.attempt, generated.smallInputs));

  round.attempt = event.attempt;
  return { outcome: 'sent', attempt: event.attempt };
}

async function runRegenerate(
  event: Extract<TestGenEvent, { mode: 'regenerate' }>,
  deps: Deps,
  round: RoundState,
  remainingMs: () => number,
): Promise<TestGenOutcome> {
  if (new Set(event.indexes).size !== event.indexes.length) {
    return { outcome: 'ignored', reason: 'duplicate indexes' };
  }
  const q = await questionsDb.getQuestion(event.questionId, event.version);
  if (!q) return { outcome: 'ignored', reason: 'question not found' };
  if (q.testAttempt !== event.attempt) return { outcome: 'stale' };

  if ((q.testRegenerations ?? 0) >= MAX_REGENERATION_ROUNDS) {
    throw new GenerationError(
      `The reference solution still failed after ${MAX_REGENERATION_ROUNDS} rounds of replacing inputs`,
    );
  }
  if (!q.signature) throw new GenerationError('The question has no signature to regenerate from');

  const keys = questionKeys(q.questionId, q.version);
  const [reference, generator, smallText] = await Promise.all([
    getText(keys.reference),
    getText(keys.generator),
    getText(keys.smallInputs),
  ]);
  const currentSmall = z.array(z.string()).parse(JSON.parse(smallText));

  const prompt = renderPrompt(extractSection(deps.prompt(), 'regenerate'), {
    ...questionValues(q),
    signature: asText(q.signature),
    referenceSolution: reference,
    generatorScript: generator,
    smallInputs: currentSmall.map((input, i) => `${i}: ${input}`).join('\n'),
    indexes: [...event.indexes].sort((a, b) => a - b).join(', '),
    reason: event.reason ?? 'The reference solution crashed or timed out on these inputs.',
  });
  const gemini = await deps.gemini();
  const regenerated = parseRegenerated(
    await askGemini(
      gemini,
      { model: model(), prompt, schema: REGENERATE_RESPONSE_SCHEMA },
      deps,
      remainingMs,
    ),
    q.signature,
    event.indexes,
    currentSmall,
  );

  const next = await questionsDb.advanceGeneration(q.questionId, q.version, event.attempt);
  if (next === 'stale') return { outcome: 'stale' };
  round.attempt = next;

  const smallInputs = currentSmall.map((old, i) => regenerated.replacements.get(i) ?? old);
  await putText(keys.smallInputs, JSON.stringify(smallInputs));
  if (regenerated.generatorScript) await putText(keys.generator, regenerated.generatorScript);
  await sendSetup(setupMessage(q, next, smallInputs));

  return { outcome: 'sent', attempt: next };
}

/**
 * Gemini is busy. Counts the try for this round; before the third try it throws, so Lambda runs
 * the same event again later (the question stays GENERATING). On the third it marks the round
 * GENERATION_FAILED. Returns undefined only if the try could not be counted, so the caller fails
 * the round the usual way.
 */
async function busyOutcome(
  event: TestGenEvent,
  round: RoundState,
  busy: GeminiBusyError,
): Promise<TestGenOutcome | undefined> {
  let tries: number | 'stale';
  try {
    tries = await questionsDb.countGenerationTry(event.questionId, event.version, round.attempt);
  } catch (error) {
    console.error('Could not count a busy try', error);
    emitAppError('generate-tests');
    return undefined;
  }
  if (tries === 'stale') return { outcome: 'stale' };

  if (tries < MAX_BUSY_TRIES) {
    console.error(
      `Gemini is busy (try ${tries} of ${MAX_BUSY_TRIES}) for ${event.questionId} v${event.version}; Lambda will run it again`,
    );
    throw busy;
  }
  await questionsDb.markGenerationFailed(
    event.questionId,
    event.version,
    round.attempt,
    BUSY_REASON,
  );
  return { outcome: 'failed', reason: BUSY_REASON };
}

/**
 * The test-generation Lambda. Any failure marks the question GENERATION_FAILED with a short
 * reason, for the round it was working on, and returns. The exception is a busy Gemini (429, 5xx,
 * timeouts that outlast the retries in one invocation): that throws, up to twice, so Lambda's
 * asynchronous retries run the event again; the third busy try fails the round.
 */
export function createHandler(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };

  return async function handler(
    raw: unknown,
    context?: { getRemainingTimeInMillis(): number },
  ): Promise<TestGenOutcome> {
    const remainingMs = () => context?.getRemainingTimeInMillis() ?? Number.POSITIVE_INFINITY;
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('Ignoring a malformed test-generation event');
      emitAppError('generate-tests');
      return { outcome: 'ignored', reason: 'malformed event' };
    }
    const event = parsed.data;
    const round: RoundState = { attempt: event.attempt };

    try {
      return event.mode === 'generate'
        ? await runGenerate(event, deps, round, remainingMs)
        : await runRegenerate(event, deps, round, remainingMs);
    } catch (error) {
      if (error instanceof GeminiBusyError) {
        const outcome = await busyOutcome(event, round, error);
        if (outcome) return outcome;
      }
      const secrets: string[] = [];
      try {
        secrets.push(await getGeminiApiKey());
      } catch {
        // no key to scrub
      }
      // A GenerationError is a planned outcome (the question or Gemini's answer was not usable);
      // anything else is something nobody expected.
      if (!(error instanceof GenerationError)) emitAppError('generate-tests');
      const reason = describe(error, secrets);
      console.error(`Test generation failed for ${event.questionId} v${event.version}: ${reason}`);
      try {
        await questionsDb.markGenerationFailed(
          event.questionId,
          event.version,
          round.attempt,
          reason,
        );
      } catch (writeError) {
        console.error('Could not record the failure', writeError);
        emitAppError('generate-tests');
      }
      return { outcome: 'failed', reason };
    }
  };
}

export const handler = createHandler();
