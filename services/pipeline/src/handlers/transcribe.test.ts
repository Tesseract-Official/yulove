import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { executeMsg, type AnswerItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiApiError } from '../lib/gemini.js';
import { loadPromptFile } from '../lib/prompt.js';
import { GeminiBusyError } from '../lib/retry.js';
import { resetGeminiApiKeyCache } from '../lib/secret.js';
import { BUSY_MESSAGE, TRANSCRIBE_RESPONSE_SCHEMA } from '../lib/transcription.js';
import { DRIVERS_FILE, TRANSCRIBE_PROMPT_FILE } from '../test-utils/paths.js';
import { apiError, CODE, DRIVER, goodReply, question, Scripted } from '../test-utils/transcribe.js';
import { createHandler, MAX_TRANSCRIBE_TRIES } from './transcribe.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const secrets = mockClient(SecretsManagerClient);

const API_KEY = 'AIza-super-secret-key';
const EXAM = 'exam-1';
const STUDENT = 's1@college.edu';
const IMAGE_KEY = 'answers/exam-1/R1/q1.jpg';
const EXECUTE_QUEUE = 'https://sqs.example/execute.fifo';
const TRANSCRIBE_QUEUE = 'https://sqs.example/transcribe.fifo';

const answerKey = { examStudent: `${EXAM}#${STUDENT}`, questionNumber: 1 };
const answer = () => db.get<AnswerItem>('Answers', answerKey);

const message = (attempt = 1) => ({
  examId: EXAM,
  studentEmail: STUDENT,
  questionNumber: 1,
  attempt,
  questionId: 'q1',
  version: 1,
});
const event = (attempt = 1) => ({ Records: [{ body: JSON.stringify(message(attempt)) }] });

const sleeps: number[] = [];
const handlerFor = (gemini: Scripted) =>
  createHandler({
    gemini: async () => gemini,
    prompt: () => loadPromptFile(TRANSCRIBE_PROMPT_FILE),
    driversGuide: () => readFileSync(DRIVERS_FILE, 'utf8'),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });

const seedAnswer = (attempt = 1, extra: Partial<AnswerItem> = {}) =>
  db.put('Answers', {
    ...answerKey,
    attempt,
    status: 'QUEUED',
    imageKey: IMAGE_KEY,
    ...extra,
  });

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  secrets.reset();
  sleeps.length = 0;
  resetGeminiApiKeyCache();
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['EXECUTE_QUEUE_URL'] = EXECUTE_QUEUE;
  process.env['TRANSCRIBE_QUEUE_URL'] = TRANSCRIBE_QUEUE;
  process.env['GEMINI_SECRET_NAME'] = 'dsa-judge/gemini-api-key';
  process.env['GEMINI_MODEL'] = 'gemini-transcribe-test';
  secrets.on(GetSecretValueCommand).resolves({ SecretString: API_KEY });
  s3.on(GetObjectCommand).resolves({
    Body: { transformToByteArray: async () => new Uint8Array([0xff, 0xd8, 0xff]) } as never,
  });
  sqs.on(SendMessageCommand).resolves({});
  sqs.on(ChangeMessageVisibilityCommand).resolves({});
  db.put('Questions', question);
  seedAnswer();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const sentToWorker = () => sqs.commandCalls(SendMessageCommand).map((c) => c.args[0].input);

describe('a valid answer', () => {
  it('stores every field, sets RUNNING, and queues the answer for the worker', async () => {
    const gemini = new Scripted([goodReply()]);

    const [outcome] = await handlerFor(gemini)(event());

    expect(outcome).toEqual({ outcome: 'sent', attempt: 1 });
    expect(answer()).toMatchObject({
      attempt: 1,
      status: 'RUNNING',
      language: 'python',
      rawTranscription: 'def solve(nums)\n return sum(nums)',
      correctedCode: CODE,
      driverCode: DRIVER,
      fixes: ['Added the missing colon', 'Restored the indentation'],
      estimatedComplexity: 'O(n)',
      meetsComplexity: true,
    });
  });

  it('sends the worker an ANSWER with the code, driver, limits, compare mode and tests', async () => {
    await handlerFor(new Scripted([goodReply()]))(event());

    const sent = sentToWorker();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      QueueUrl: EXECUTE_QUEUE,
      MessageGroupId: 'exam-1#s1@college.edu',
      MessageDeduplicationId: 'exam-1#s1@college.edu#1#1',
    });
    expect(executeMsg.parse(JSON.parse(sent[0]?.MessageBody ?? ''))).toEqual({
      type: 'ANSWER',
      examId: EXAM,
      studentEmail: STUDENT,
      questionNumber: 1,
      attempt: 1,
      questionId: 'q1',
      version: 1,
      language: 'python',
      correctedCode: CODE,
      driverCode: DRIVER,
      testsKey: 'questions/q1/v1/tests.json',
      timeLimitMs: 2000,
      memoryMb: 256,
      compareMode: 'EXACT',
    });
  });

  it('asks the model for JSON with the photo, the question and the drivers guide', async () => {
    const gemini = new Scripted([goodReply()]);
    await handlerFor(gemini)(event());

    const request = gemini.requests[0];
    expect(request?.model).toBe('gemini-transcribe-test');
    expect(request?.schema).toBe(TRANSCRIBE_RESPONSE_SCHEMA);
    expect(request?.image).toEqual({
      mimeType: 'image/jpeg',
      data: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(request?.prompt).toContain('Return the sum of the list.');
    expect(request?.prompt).toContain('solve(nums: int[]) -> int');
    expect(request?.prompt).toContain(readFileSync(DRIVERS_FILE, 'utf8'));
    expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: 'bucket',
      Key: IMAGE_KEY,
    });
  });

  it('marks the answer TRANSCRIBING while Gemini works', async () => {
    let seen: string | undefined;
    const gemini = new Scripted([goodReply()]);
    const original = gemini.generateJson.bind(gemini);
    gemini.generateJson = async (request) => {
      seen = answer()?.status;
      return original(request);
    };
    await handlerFor(gemini)(event());
    expect(seen).toBe('TRANSCRIBING');
  });

  it('uses the question version limits and an explicit testsKey when there is one', async () => {
    db.put('Questions', {
      ...question,
      timeLimitMs: 5000,
      memoryMb: 512,
      compareMode: 'ANY_ORDER',
      testsKey: 'questions/q1/v1/tests.json',
    });
    await handlerFor(new Scripted([goodReply()]))(event());
    expect(JSON.parse(sentToWorker()[0]?.MessageBody ?? '')).toMatchObject({
      timeLimitMs: 5000,
      memoryMb: 512,
      compareMode: 'ANY_ORDER',
    });
  });

  it('clears an earlier failure reason', async () => {
    seedAnswer(1, { status: 'QUEUED', failReason: 'UNREADABLE', failDetail: 'old' });
    await handlerFor(new Scripted([goodReply()]))(event());
    expect(answer()).not.toHaveProperty('failReason');
    expect(answer()).not.toHaveProperty('failDetail');
  });
});

describe('answers that cannot be graded', () => {
  it('count one FailedToGrade metric each', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handlerFor(
      new Scripted([goodReply({ readable: false, correctedCode: '', driverCode: '' })]),
    )(event());
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ FailedToGrade: 1, reason: 'UNREADABLE' })]);
    log.mockRestore();
  });

  const failed = (failReason: string, detail?: RegExp | string) => {
    expect(answer()).toMatchObject({ attempt: 1, status: 'FAILED_TO_GRADE', failReason });
    if (detail) expect(answer()?.failDetail).toMatch(detail);
    expect(sentToWorker()).toHaveLength(0);
  };

  it('an unreadable page', async () => {
    const [outcome] = await handlerFor(
      new Scripted([goodReply({ readable: false, correctedCode: '', driverCode: '' })]),
    )(event());

    expect(outcome).toMatchObject({ outcome: 'failed', failReason: 'UNREADABLE' });
    failed('UNREADABLE', /could not be read/);
  });

  it('an unsupported language', async () => {
    await handlerFor(new Scripted([goodReply({ language: 'other' })]))(event());
    failed('UNSUPPORTED_LANGUAGE', /Python, C\+\+, Java or Go/);
  });

  it('a driver that alters the code', async () => {
    await handlerFor(
      new Scripted([goodReply({ driverCode: DRIVER.replace('sum(nums)', 'max(nums)') })]),
    )(event());
    failed('DRIVER_MISMATCH', /changed the student code/);
  });

  it('empty corrected code', async () => {
    await handlerFor(new Scripted([goodReply({ correctedCode: '' })]))(event());
    failed('UNREADABLE', /No code found/);
  });

  it('malformed JSON', async () => {
    await handlerFor(new Scripted(['{"readable": tru']))(event());
    failed('GEMINI_ERROR', /malformed JSON/);
  });

  it('a reply of the wrong shape', async () => {
    await handlerFor(new Scripted([JSON.stringify({ readable: true })]))(event());
    failed('GEMINI_ERROR', /missing or wrong fields/);
  });

  it('a Gemini error that cannot be retried, without leaking the API key', async () => {
    await handlerFor(new Scripted([apiError(400)]))(event());
    failed('GEMINI_ERROR', /Gemini request failed/);

    const key = await handlerFor(new Scripted([new Error(`API key ${API_KEY} is invalid`)]))(
      event(1),
    );
    expect(JSON.stringify(key)).not.toContain(API_KEY);
    expect(answer()?.failDetail).not.toContain(API_KEY);
  });
});

describe('Gemini 429 and 5xx errors', () => {
  it('a 429 and then success: retried with a wait, then graded', async () => {
    const gemini = new Scripted([apiError(429), goodReply()]);
    const [outcome] = await handlerFor(gemini)(event());

    expect(outcome).toEqual({ outcome: 'sent', attempt: 1 });
    expect(gemini.requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(answer()?.status).toBe('RUNNING');
  });

  it('a 500 is retried too', async () => {
    const gemini = new Scripted([apiError(500), apiError(503), goodReply()]);
    await handlerFor(gemini)(event());
    expect(gemini.requests).toHaveLength(3);
    expect(sleeps).toEqual([2000, 4000]);
  });
});

const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';
/** A 429 the way Google sends it, with an optional RetryInfo. */
const rateLimited = (retryDelay?: string) =>
  new GeminiApiError(
    429,
    JSON.stringify({
      error: {
        code: 429,
        message: 'Quota exceeded for this model',
        status: 'RESOURCE_EXHAUSTED',
        ...(retryDelay ? { details: [{ '@type': RETRY_INFO, retryDelay }] } : {}),
      },
    }),
  );

const busyEvent = (attempt = 1, receiptHandle: string | undefined = 'receipt-1') => ({
  Records: [
    { body: JSON.stringify(message(attempt)), ...(receiptHandle ? { receiptHandle } : {}) },
  ],
});
const visibility = () =>
  sqs.commandCalls(ChangeMessageVisibilityCommand).map((c) => c.args[0].input);
const rateLimitedFourTimes = (retryDelay?: string) =>
  new Scripted([1, 2, 3, 4].map(() => rateLimited(retryDelay)));

describe('Google asks for a delay', () => {
  it('waits as long as Google says (plus a little) when there is time, then succeeds', async () => {
    const gemini = new Scripted([rateLimited('34s'), goodReply()]);
    const [outcome] = await handlerFor(gemini)(busyEvent(), {
      getRemainingTimeInMillis: () => 120_000,
    });

    expect(outcome).toEqual({ outcome: 'sent', attempt: 1 });
    expect(sleeps).toEqual([34_250]);
    expect(answer()).toMatchObject({ status: 'RUNNING' });
  });

  it('uses fractions of a second', async () => {
    await handlerFor(new Scripted([rateLimited('0.5s'), goodReply()]))(busyEvent());
    expect(sleeps).toEqual([750]);
  });

  it('backs off as usual when Google gives no delay', async () => {
    await handlerFor(new Scripted([rateLimited(), goodReply()]))(busyEvent());
    expect(sleeps).toEqual([2000]);
  });

  it("backs off as usual when Google's delay does not fit in the time left", async () => {
    // 100 s left; a 70 s wait plus the 50 s a new call may need does not fit, a 2 s backoff does.
    const gemini = new Scripted([rateLimited('70s'), goodReply()]);
    await handlerFor(gemini)(busyEvent(), { getRemainingTimeInMillis: () => 100_000 });
    expect(sleeps).toEqual([2000]);
    expect(answer()?.status).toBe('RUNNING');
  });

  it('does not retry at all when nothing fits, and treats Gemini as busy', async () => {
    const gemini = new Scripted([rateLimited('70s'), goodReply()]);
    await expect(
      handlerFor(gemini)(busyEvent(), { getRemainingTimeInMillis: () => 20_000 }),
    ).rejects.toThrow(GeminiBusyError);
    expect(gemini.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe('Gemini still busy after the retries in one call', () => {
  it('first time: counts the try, hides the message for 60 s, leaves it TRANSCRIBING and throws', async () => {
    const gemini = rateLimitedFourTimes();

    await expect(handlerFor(gemini)(busyEvent())).rejects.toThrow(GeminiBusyError);

    expect(gemini.requests).toHaveLength(4);
    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(answer()).toMatchObject({ attempt: 1, status: 'TRANSCRIBING', transcribeTries: 1 });
    expect(answer()).not.toHaveProperty('failReason');
    expect(visibility()).toEqual([
      { QueueUrl: TRANSCRIBE_QUEUE, ReceiptHandle: 'receipt-1', VisibilityTimeout: 60 },
    ]);
    expect(sentToWorker()).toHaveLength(0);
  });

  it('second time: hides it for 120 s and throws again', async () => {
    seedAnswer(1, { status: 'TRANSCRIBING', transcribeTries: 1 });

    await expect(handlerFor(rateLimitedFourTimes())(busyEvent())).rejects.toThrow(GeminiBusyError);

    expect(answer()).toMatchObject({ status: 'TRANSCRIBING', transcribeTries: 2 });
    expect(visibility()[0]?.VisibilityTimeout).toBe(120);
  });

  it('third time: gives up with "Transcription service busy, re-run" and does not throw', async () => {
    seedAnswer(1, { status: 'TRANSCRIBING', transcribeTries: MAX_TRANSCRIBE_TRIES - 1 });

    const [outcome] = await handlerFor(rateLimitedFourTimes())(busyEvent());

    expect(MAX_TRANSCRIBE_TRIES).toBe(3);
    expect(outcome).toEqual({
      outcome: 'failed',
      failReason: 'GEMINI_ERROR',
      detail: 'Transcription service busy, re-run',
    });
    expect(answer()).toMatchObject({
      status: 'FAILED_TO_GRADE',
      failReason: 'GEMINI_ERROR',
      failDetail: BUSY_MESSAGE,
    });
    expect(answer()).not.toHaveProperty('transcribeTries');
    expect(visibility()).toHaveLength(0);
  });

  it('goes through all three tries in turn, then the answer is failed', async () => {
    const handler = (g: Scripted) => handlerFor(g)(busyEvent());
    await expect(handler(rateLimitedFourTimes())).rejects.toThrow(GeminiBusyError);
    await expect(handler(rateLimitedFourTimes())).rejects.toThrow(GeminiBusyError);
    const [outcome] = await handler(rateLimitedFourTimes());

    expect(outcome).toMatchObject({ outcome: 'failed', detail: BUSY_MESSAGE });
    expect(visibility().map((v) => v.VisibilityTimeout)).toEqual([60, 120]);
    expect(answer()?.status).toBe('FAILED_TO_GRADE');
  });

  it('then succeeds if Gemini recovers on a later try, and forgets the count', async () => {
    await expect(handlerFor(rateLimitedFourTimes())(busyEvent())).rejects.toThrow(GeminiBusyError);
    expect(answer()?.transcribeTries).toBe(1);

    const [outcome] = await handlerFor(new Scripted([goodReply()]))(busyEvent());

    expect(outcome).toEqual({ outcome: 'sent', attempt: 1 });
    expect(answer()).toMatchObject({ status: 'RUNNING' });
    expect(answer()).not.toHaveProperty('transcribeTries');
  });

  it('hides the message for as long as Google asked, within 30 s and 5 minutes', async () => {
    for (const [asked, expected] of [
      ['90s', 90],
      ['10s', 30],
      ['1200s', 300],
    ] as const) {
      db.reset();
      db.put('Questions', question);
      seedAnswer();
      sqs.resetHistory();
      await expect(handlerFor(rateLimitedFourTimes(asked))(busyEvent())).rejects.toThrow(
        GeminiBusyError,
      );
      expect(visibility()[0]?.VisibilityTimeout).toBe(expected);
    }
  });

  it.each([
    ['503', () => apiError(503)],
    ['500', () => apiError(500)],
    ['a timeout', () => Object.assign(new Error('timed out'), { name: 'AbortError' })],
    ['a dropped connection', () => Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
  ])('treats %s like a rate limit', async (_name, make) => {
    const gemini = new Scripted([make(), make(), make(), make()]);
    await expect(handlerFor(gemini)(busyEvent())).rejects.toThrow(GeminiBusyError);
    expect(answer()).toMatchObject({ status: 'TRANSCRIBING', transcribeTries: 1 });
  });

  it('still throws when the wait cannot be shortened, and when there is no receipt handle', async () => {
    sqs.on(ChangeMessageVisibilityCommand).rejects(new Error('denied'));
    await expect(handlerFor(rateLimitedFourTimes())(busyEvent())).rejects.toThrow(GeminiBusyError);

    sqs.resetHistory();
    seedAnswer();
    const noReceipt = { Records: [{ body: JSON.stringify(message(1)) }] };
    await expect(handlerFor(rateLimitedFourTimes())(noReceipt)).rejects.toThrow(GeminiBusyError);
    expect(visibility()).toHaveLength(0);
  });

  it('does not count or throw for a page that has been replaced by a newer attempt', async () => {
    const gemini = rateLimitedFourTimes();
    const original = gemini.generateJson.bind(gemini);
    gemini.generateJson = async (request) => {
      seedAnswer(2, { status: 'QUEUED' });
      return original(request);
    };

    const [outcome] = await handlerFor(gemini)(busyEvent(1));

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(answer()).not.toHaveProperty('transcribeTries');
    expect(visibility()).toHaveLength(0);
  });

  it('a new attempt starts again from zero tries', async () => {
    seedAnswer(1, { status: 'TRANSCRIBING', transcribeTries: 2 });
    // The batch manager submits again: attempt 2 (beginAttempt clears the count).
    seedAnswer(2, { status: 'QUEUED' });

    await expect(handlerFor(rateLimitedFourTimes())(busyEvent(2))).rejects.toThrow(GeminiBusyError);
    expect(answer()).toMatchObject({ attempt: 2, transcribeTries: 1 });
  });
});

describe('failures that are not about Gemini being busy', () => {
  it.each([
    ['a 400', () => new Scripted([apiError(400)])],
    ['an unreadable page', () => new Scripted([goodReply({ readable: false })])],
    ['malformed JSON', () => new Scripted(['{nope'])],
    ['an unsupported language', () => new Scripted([goodReply({ language: 'other' })])],
  ])('%s fails at once, is deleted, and is not counted', async (_name, make) => {
    const [outcome] = await handlerFor(make())(busyEvent());

    expect(outcome).toMatchObject({ outcome: 'failed' });
    expect(answer()?.status).toBe('FAILED_TO_GRADE');
    expect(answer()).not.toHaveProperty('transcribeTries');
    expect(visibility()).toHaveLength(0);
  });
});

describe('a stale attempt', () => {
  it('does nothing when a newer attempt exists, and writes nothing', async () => {
    seedAnswer(2, { status: 'QUEUED' });
    const gemini = new Scripted([goodReply()]);

    const [outcome] = await handlerFor(gemini)(event(1));

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(gemini.requests).toHaveLength(0);
    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(sentToWorker()).toHaveLength(0);
  });

  it('does nothing when the answer does not exist', async () => {
    db.reset();
    db.put('Questions', question);
    const [outcome] = await handlerFor(new Scripted([]))(event());
    expect(outcome).toEqual({ outcome: 'stale' });
    expect(db.all('Answers')).toHaveLength(0);
  });

  it('never overwrites a newer attempt with its result, however late it finishes', async () => {
    const gemini = new Scripted([goodReply()]);
    const original = gemini.generateJson.bind(gemini);
    gemini.generateJson = async (request) => {
      // While attempt 1 waits for Gemini, the batch manager submits the page again.
      seedAnswer(2, { status: 'QUEUED' });
      return original(request);
    };

    const [outcome] = await handlerFor(gemini)(event(1));

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(answer()).not.toHaveProperty('correctedCode');
    expect(sentToWorker()).toHaveLength(0);
  });

  it('never overwrites a newer attempt with its failure', async () => {
    const gemini = new Scripted(['{not json']);
    const original = gemini.generateJson.bind(gemini);
    gemini.generateJson = async (request) => {
      seedAnswer(2, { status: 'QUEUED' });
      return original(request);
    };

    await handlerFor(gemini)(event(1));

    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(answer()).not.toHaveProperty('failReason');
  });

  it('the newer attempt then runs normally', async () => {
    seedAnswer(2, { status: 'QUEUED' });
    await handlerFor(new Scripted([goodReply()]))(event(2));
    expect(answer()).toMatchObject({ attempt: 2, status: 'RUNNING' });
    expect(sentToWorker()[0]?.MessageDeduplicationId).toBe('exam-1#s1@college.edu#1#2');
  });
});

describe('things that go wrong around Gemini', () => {
  it('fails the answer when the question has gone', async () => {
    db.reset();
    seedAnswer();
    const [outcome] = await handlerFor(new Scripted([]))(event());
    expect(outcome).toMatchObject({ outcome: 'failed', failReason: 'WORKER_ERROR' });
    expect(answer()?.failDetail).toMatch(/not found/);
  });

  it.each([
    ['has no signature', { signature: undefined }],
    ['has no approved tests', { testStatus: 'NEEDS_REVIEW' as const }],
  ])('fails the answer when the question %s', async (_name, change) => {
    db.put('Questions', { ...question, ...change });
    await handlerFor(new Scripted([goodReply()]))(event());
    expect(answer()).toMatchObject({ status: 'FAILED_TO_GRADE', failReason: 'WORKER_ERROR' });
    expect(sentToWorker()).toHaveLength(0);
  });

  it('fails the answer when the photo is missing from S3', async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
    await handlerFor(new Scripted([goodReply()]))(event());
    expect(answer()).toMatchObject({ failReason: 'WORKER_ERROR' });
    expect(answer()?.failDetail).toMatch(/photo could not be found/);
  });

  it('fails the answer when it has no image key', async () => {
    seedAnswer(1, { imageKey: undefined });
    await handlerFor(new Scripted([goodReply()]))(event());
    expect(answer()?.failDetail).toMatch(/No photo is stored/);
  });

  it('fails the answer when the worker queue cannot be reached', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('queue down'));
    const [outcome] = await handlerFor(new Scripted([goodReply()]))(event());

    expect(outcome).toMatchObject({ outcome: 'failed', failReason: 'WORKER_ERROR' });
    expect(answer()).toMatchObject({ status: 'FAILED_TO_GRADE', failReason: 'WORKER_ERROR' });
    expect(answer()?.failDetail).toMatch(/Could not queue the answer for execution/);
  });

  it('never throws, even for an unexpected error', async () => {
    s3.on(GetObjectCommand).rejects(new Error('S3 exploded'));
    const [outcome] = await handlerFor(new Scripted([goodReply()]))(event());
    expect(outcome).toMatchObject({ outcome: 'failed', failReason: 'WORKER_ERROR' });
    expect(answer()?.failDetail).toMatch(/S3 exploded/);
  });

  it('never throws when it cannot even record the failure', async () => {
    s3.on(GetObjectCommand).rejects(new Error('S3 exploded'));
    const gemini = new Scripted([]);
    const handler = handlerFor(gemini);
    process.env['ANSWERS_TABLE'] = 'missing-table';
    await expect(handler(event())).resolves.toBeDefined();
    process.env['ANSWERS_TABLE'] = 'Answers';
  });

  it('drops a message it cannot read', async () => {
    const [outcome] = await handlerFor(new Scripted([]))({
      Records: [{ body: 'not json' }, { body: JSON.stringify({ examId: 'x' }) }],
    });
    expect(outcome).toEqual({ outcome: 'ignored', reason: 'unreadable message' });
    expect(answer()).toMatchObject({ attempt: 1, status: 'QUEUED' });
  });

  it('reports a model that is not set', async () => {
    process.env['GEMINI_MODEL'] = '<MODEL>';
    const [outcome] = await handlerFor(new Scripted([goodReply()]))(event());
    expect(outcome).toMatchObject({ outcome: 'failed', failReason: 'WORKER_ERROR' });
    expect(answer()?.failDetail).toMatch(/geminiTranscribeModel/);
  });
});
