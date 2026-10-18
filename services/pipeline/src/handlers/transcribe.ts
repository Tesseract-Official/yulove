import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  emitAppError,
  BUCKET_ENV,
  executeMsg,
  messageDeduplicationId,
  messageGroupId,
  QUEUE_ENV,
  questionKeys,
  transcribeMsg,
  type FailReason,
  type TranscribeMsg,
} from '@yulove/shared';
import { answersDb, questionsDb } from '@yulove/shared/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGeminiClient, type GeminiClient } from '../lib/gemini.js';
import { loadPromptFile } from '../lib/prompt.js';
import { GeminiBusyError, redeliveryDelaySeconds } from '../lib/retry.js';
import { getGeminiApiKey, requireEnv } from '../lib/secret.js';
import {
  BUSY_MESSAGE,
  buildTranscribePrompt,
  describeError,
  formatAttempt,
  transcribeImage,
} from '../lib/transcription.js';

/** Times transcription may end because Gemini is busy before the answer is failed. */
export const MAX_TRANSCRIBE_TRIES = 3;

export type TranscribeOutcome =
  | { outcome: 'sent'; attempt: number }
  | { outcome: 'stale' }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'failed'; failReason: FailReason; detail: string };

export interface Deps {
  /** A Gemini client; the real one reads the API key from Secrets Manager (cached). */
  gemini(): Promise<GeminiClient>;
  /** prompts/transcribe.md */
  prompt(): string;
  /** worker/DRIVERS.md, in full. */
  driversGuide(): string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultDeps: Deps = {
  async gemini() {
    return createGeminiClient(await getGeminiApiKey());
  },
  prompt: () => loadPromptFile(join(__dirname, 'transcribe.md')),
  driversGuide: () => readFileSync(join(__dirname, 'DRIVERS.md'), 'utf8'),
};

function model(): string {
  const value = process.env['GEMINI_MODEL'];
  if (!value || value.startsWith('<')) {
    throw new Error('The Gemini model is not configured (geminiTranscribeModel in infra/cdk.json)');
  }
  return value;
}

/** What the Lambda runtime gives a handler. */
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

export interface SqsRecordEvent {
  Records: Array<{ body: string; receiptHandle?: string }>;
}

/** Ends the answer as FAILED_TO_GRADE for this attempt. A stale attempt is left alone. */
async function failAnswer(
  msg: TranscribeMsg,
  failReason: FailReason,
  detail: string,
): Promise<TranscribeOutcome> {
  console.error(
    `Transcription of ${msg.examId}/${msg.studentEmail}/q${msg.questionNumber} (attempt ${msg.attempt}) failed: ${failReason}: ${detail}`,
  );
  try {
    await answersDb.markFailed(
      { examId: msg.examId, studentEmail: msg.studentEmail, questionNumber: msg.questionNumber },
      msg.attempt,
      failReason,
      detail,
    );
  } catch (error) {
    console.error('Could not record the failure', error);
    emitAppError('transcribe');
  }
  return { outcome: 'failed', failReason, detail };
}

async function readImage(bucket: string, key: string): Promise<Uint8Array | undefined> {
  try {
    const out = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await out.Body?.transformToByteArray()) ?? undefined;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return undefined;
    throw error;
  }
}

/**
 * Hides this message from the queue for `seconds`, so SQS gives it to a Lambda again then rather
 * than after the queue's own 12 minutes. If this fails the queue's timeout simply applies.
 */
async function hideFor(receiptHandle: string | undefined, seconds: number): Promise<void> {
  if (!receiptHandle) return;
  try {
    await new SQSClient({}).send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: requireEnv(QUEUE_ENV.transcribe),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  } catch (error) {
    console.error('Could not shorten the wait before the message is delivered again', error);
  }
}

async function transcribeOne(
  msg: TranscribeMsg,
  deps: Deps,
  remainingMs: () => number,
  receiptHandle: string | undefined,
): Promise<TranscribeOutcome> {
  const key = {
    examId: msg.examId,
    studentEmail: msg.studentEmail,
    questionNumber: msg.questionNumber,
  };

  // Only the newest attempt may go on; every write below repeats this check.
  const answer = await answersDb.getAnswer(key);
  if (!answer || answer.attempt !== msg.attempt) return { outcome: 'stale' };
  if ((await answersDb.setAnswerStatus(key, msg.attempt, 'TRANSCRIBING')) === 'stale') {
    return { outcome: 'stale' };
  }

  const question = await questionsDb.getQuestion(msg.questionId, msg.version);
  if (!question) {
    return failAnswer(msg, 'WORKER_ERROR', `Question ${msg.questionId} v${msg.version} not found`);
  }
  if (!question.signature || question.testStatus !== 'APPROVED') {
    return failAnswer(msg, 'WORKER_ERROR', 'The question has no approved tests');
  }
  if (!answer.imageKey) {
    return failAnswer(msg, 'WORKER_ERROR', 'No photo is stored for this answer');
  }
  const image = await readImage(requireEnv(BUCKET_ENV), answer.imageKey);
  if (!image || image.length === 0) {
    return failAnswer(msg, 'WORKER_ERROR', 'The photo could not be found; upload it again');
  }

  const prompt = buildTranscribePrompt(deps.prompt(), question, deps.driversGuide());
  const secrets: string[] = [];
  const gemini = await deps.gemini();
  try {
    secrets.push(await getGeminiApiKey());
  } catch {
    // the client was supplied by a test
  }

  const { verdict, busy, retryDelayMs } = await transcribeImage({
    gemini,
    model: model(),
    prompt,
    image,
    secrets,
    remainingMs,
    onAttempt: (info) => console.error(formatAttempt(info, secrets)),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  });
  if (busy) {
    // Gemini is rate limited or down. That is not the answer's fault: try again later, and only
    // give up on the third time.
    const tries = await answersDb.countTranscribeTry(key, msg.attempt);
    if (tries === 'stale') return { outcome: 'stale' };
    if (tries >= MAX_TRANSCRIBE_TRIES) return failAnswer(msg, 'GEMINI_ERROR', BUSY_MESSAGE);

    const wait = redeliveryDelaySeconds(tries, retryDelayMs);
    console.error(
      `Gemini is busy (try ${tries} of ${MAX_TRANSCRIBE_TRIES}) for ${msg.examId}/${msg.studentEmail}/q${msg.questionNumber}; the message will be delivered again in ${wait} s`,
    );
    await hideFor(receiptHandle, wait);
    throw new GeminiBusyError(
      `Gemini is busy (try ${tries} of ${MAX_TRANSCRIBE_TRIES})`,
      retryDelayMs,
    );
  }
  if (!verdict.ok) return failAnswer(msg, verdict.failReason, verdict.detail);

  const saved = await answersDb.saveTranscription(key, msg.attempt, verdict.transcription);
  if (saved === 'stale') return { outcome: 'stale' };

  const execute = executeMsg.parse({
    type: 'ANSWER',
    ...key,
    attempt: msg.attempt,
    questionId: question.questionId,
    version: question.version,
    language: verdict.transcription.language,
    correctedCode: verdict.transcription.correctedCode,
    driverCode: verdict.transcription.driverCode,
    testsKey: question.testsKey ?? questionKeys(question.questionId, question.version).tests,
    timeLimitMs: question.timeLimitMs,
    memoryMb: question.memoryMb,
    compareMode: question.compareMode,
  });
  try {
    await new SQSClient({}).send(
      new SendMessageCommand({
        QueueUrl: requireEnv(QUEUE_ENV.execute),
        MessageBody: JSON.stringify(execute),
        MessageGroupId: messageGroupId(key.examId, key.studentEmail),
        MessageDeduplicationId: messageDeduplicationId(
          key.examId,
          key.studentEmail,
          key.questionNumber,
          msg.attempt,
        ),
      }),
    );
  } catch (error) {
    emitAppError('transcribe');
    return failAnswer(
      msg,
      'WORKER_ERROR',
      describeError(error, [], 'Could not queue the answer for execution: '),
    );
  }
  return { outcome: 'sent', attempt: msg.attempt };
}

/**
 * The Transcribe Lambda (SQS trigger, batch size 1). Any failure of the answer itself marks it
 * FAILED_TO_GRADE for the attempt it was working on and the message is deleted, because a FIFO
 * queue with no dead-letter queue would otherwise retry it forever.
 *
 * The one exception is a busy Gemini (429, 5xx, timeouts that outlast the in-call retries): the
 * handler counts the try on the answer and throws, so the message comes back later. The trigger
 * must not report partial batch failures (they are off), so a thrown error returns the whole,
 * one-message batch. After the third busy try the answer is failed as "Transcription service busy,
 * re-run".
 */
export function createHandler(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };

  return async function handler(
    event: SqsRecordEvent,
    context?: LambdaContext,
  ): Promise<TranscribeOutcome[]> {
    const remainingMs = () => context?.getRemainingTimeInMillis() ?? Number.POSITIVE_INFINITY;
    const outcomes: TranscribeOutcome[] = [];

    for (const record of event.Records) {
      let msg: TranscribeMsg;
      try {
        msg = transcribeMsg.parse(JSON.parse(record.body));
      } catch {
        // Nobody can be told about a message that cannot be read. Drop it.
        console.error('Ignoring an unreadable transcribe message');
        emitAppError('transcribe');
        outcomes.push({ outcome: 'ignored', reason: 'unreadable message' });
        continue;
      }

      try {
        outcomes.push(await transcribeOne(msg, deps, remainingMs, record.receiptHandle));
      } catch (error) {
        // Not a failure of the answer: let the invocation fail so SQS delivers the message again.
        if (error instanceof GeminiBusyError) throw error;
        emitAppError('transcribe');
        let secret = '';
        try {
          secret = await getGeminiApiKey();
        } catch {
          // none to hide
        }
        outcomes.push(
          await failAnswer(
            msg,
            'WORKER_ERROR',
            describeError(error, [secret], 'Transcription failed: '),
          ),
        );
      }
    }
    return outcomes;
  };
}

export const handler = createHandler();
