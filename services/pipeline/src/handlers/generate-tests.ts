import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
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

export type TestGenOutcome =
  | { outcome: 'sent'; attempt: number }
  | { outcome: 'stale' }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'failed'; reason: string };

export interface Deps {
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
): Promise<TestGenOutcome> {
  const q = await questionsDb.getQuestion(event.questionId, event.version);
  if (!q) return { outcome: 'ignored', reason: 'question not found' };
  if (q.testAttempt !== event.attempt) return { outcome: 'stale' };

  const modelName = model();
  const prompt = renderPrompt(extractSection(deps.prompt(), 'generate'), questionValues(q));
  const gemini = await deps.gemini();
  const generated = parseGenerated(
    await gemini.generateJson({ model: modelName, prompt, schema: GENERATE_RESPONSE_SCHEMA }),
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
    await gemini.generateJson({ model: model(), prompt, schema: REGENERATE_RESPONSE_SCHEMA }),
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
 * The test-generation Lambda. It never throws: any failure marks the question GENERATION_FAILED
 * with a short reason, for the round it was working on.
 */
export function createHandler(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };

  return async function handler(raw: unknown): Promise<TestGenOutcome> {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('Ignoring a malformed test-generation event');
      return { outcome: 'ignored', reason: 'malformed event' };
    }
    const event = parsed.data;
    const round: RoundState = { attempt: event.attempt };

    try {
      return event.mode === 'generate'
        ? await runGenerate(event, deps, round)
        : await runRegenerate(event, deps, round);
    } catch (error) {
      const secrets: string[] = [];
      try {
        secrets.push(await getGeminiApiKey());
      } catch {
        // no key to scrub
      }
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
      }
      return { outcome: 'failed', reason };
    }
  };
}

export const handler = createHandler();
