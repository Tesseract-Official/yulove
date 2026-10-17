import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { executeMsg, type QuestionItem } from '@yulove/shared';
import { questionsDb } from '@yulove/shared/server';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { GeminiApiError, type GeminiClient, type GenerateJsonRequest } from '../lib/gemini.js';
import { GeminiBusyError } from '../lib/retry.js';
import { loadPromptFile } from '../lib/prompt.js';
import { resetGeminiApiKeyCache } from '../lib/secret.js';
import { GENERATE_RESPONSE_SCHEMA, REGENERATE_RESPONSE_SCHEMA } from '../lib/responses.js';
import { PROMPT_FILE } from '../test-utils/paths.js';
import {
  BUSY_REASON,
  createHandler,
  GEMINI_CALL_TIMEOUT_MS,
  MAX_BUSY_TRIES,
  MAX_REGENERATION_ROUNDS,
} from './generate-tests.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const secrets = mockClient(SecretsManagerClient);

const API_KEY = 'AIza-super-secret-key';

/** A scripted Gemini: returns the next reply, or throws it if it is an Error. */
class FakeGemini implements GeminiClient {
  readonly requests: GenerateJsonRequest[] = [];
  constructor(private readonly replies: Array<string | Error>) {}

  async generateJson(request: GenerateJsonRequest): Promise<string> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error('FakeGemini has no reply left');
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

const signature = {
  name: 'twoSum',
  parameters: [
    { name: 'nums', type: 'int[]' },
    { name: 'target', type: 'int' },
  ],
  returnType: 'int[]',
};

const smallInputs = Array.from({ length: 7 }, (_, i) =>
  JSON.stringify({ nums: [i, i + 1], target: i }),
);

const validReply = (change: Record<string, unknown> = {}) =>
  JSON.stringify({
    signature,
    referenceSolution: 'import json, sys\nprint(json.dumps([0, 1]))',
    smallInputs,
    generatorScript: 'import sys\nprint("{}")',
    ...change,
  });

const baseQuestion = (extra: Partial<QuestionItem> = {}): QuestionItem => ({
  questionId: 'q1',
  version: 1,
  teacherEmail: 'teacher@college.edu',
  title: 'Two Sum',
  statement: 'Find two numbers that add up to the target.',
  ioDescription: 'Input: nums and target. Output: two indexes.',
  constraints: '2 <= n <= 100000',
  examples: [{ input: '[2,7] 9', output: '[0,1]' }],
  targetComplexity: 'O(n)',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
  testStatus: 'GENERATING',
  testAttempt: 1,
  ...extra,
});

const stored = () => db.get<QuestionItem>('Questions', { questionId: 'q1', version: 1 });
const handlerFor = (gemini: FakeGemini) =>
  createHandler({ gemini: async () => gemini, prompt: () => loadPromptFile(PROMPT_FILE) });

const generateEvent = { mode: 'generate', questionId: 'q1', version: 1, attempt: 1 };

const puts = () =>
  Object.fromEntries(
    s3.commandCalls(PutObjectCommand).map((c) => [c.args[0].input.Key, c.args[0].input.Body]),
  );

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  secrets.reset();
  resetGeminiApiKeyCache();
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['EXECUTE_QUEUE_URL'] = 'https://sqs.example/execute.fifo';
  process.env['GEMINI_SECRET_NAME'] = 'dsa-judge/gemini-api-key';
  process.env['GEMINI_MODEL'] = 'gemini-test-model';
  secrets.on(GetSecretValueCommand).resolves({ SecretString: API_KEY });
  s3.on(PutObjectCommand).resolves({});
  sqs.on(SendMessageCommand).resolves({});
  db.put('Questions', baseQuestion());
});

describe('generate mode: a valid response', () => {
  it('saves the files, the signature, and sends one SETUP message', async () => {
    const gemini = new FakeGemini([validReply()]);

    const result = await handlerFor(gemini)(generateEvent);

    expect(result).toEqual({ outcome: 'sent', attempt: 1 });

    expect(puts()).toEqual({
      'questions/q1/v1/reference.py': 'import json, sys\nprint(json.dumps([0, 1]))',
      'questions/q1/v1/generator.py': 'import sys\nprint("{}")',
      'questions/q1/v1/small-inputs.json': JSON.stringify(smallInputs),
    });
    expect(
      s3.commandCalls(PutObjectCommand).every((c) => c.args[0].input.Bucket === 'bucket'),
    ).toBe(true);

    const sent = sqs.commandCalls(SendMessageCommand);
    expect(sent).toHaveLength(1);
    const input = sent[0]?.args[0].input;
    expect(input?.QueueUrl).toBe('https://sqs.example/execute.fifo');
    expect(input?.MessageGroupId).toBe('setup#q1');
    expect(input?.MessageDeduplicationId).toBe('setup#q1#1#1');
    expect(executeMsg.parse(JSON.parse(input?.MessageBody as string))).toEqual({
      type: 'SETUP',
      questionId: 'q1',
      version: 1,
      attempt: 1,
      referenceKey: 'questions/q1/v1/reference.py',
      generatorKey: 'questions/q1/v1/generator.py',
      smallInputs,
      largeInputCount: 3,
      testsKey: 'questions/q1/v1/tests.json',
      timeLimitMs: 2000,
      memoryMb: 256,
      compareMode: 'EXACT',
    });

    expect(stored()).toMatchObject({ signature, testStatus: 'GENERATING', testAttempt: 1 });
    expect(stored()?.testFailure).toBeUndefined();
  });

  it('asks Gemini with the configured model, the JSON schema and a fully filled prompt', async () => {
    const gemini = new FakeGemini([validReply()]);

    await handlerFor(gemini)(generateEvent);

    expect(gemini.requests).toHaveLength(1);
    const [request] = gemini.requests;
    expect(request?.model).toBe('gemini-test-model');
    expect(request?.schema).toBe(GENERATE_RESPONSE_SCHEMA);
    expect(request?.prompt).toContain('Two Sum');
    expect(request?.prompt).toContain('Find two numbers that add up to the target.');
    expect(request?.prompt).toContain('Target time complexity: O(n)');
    expect(request?.prompt).toContain('Time limit per test: 2000 ms');
    expect(request?.prompt).toContain('Input: [2,7] 9');
    expect(request?.prompt).not.toMatch(/\{\{|\}\}/);
    expect(request?.prompt).not.toContain('replacements');
    // The input/output convention is spelled out.
    expect(request?.prompt).toContain("keys are exactly the signature's parameter names");
    expect(request?.prompt).toContain('print(json.dumps(result))');
    expect(request?.prompt).toContain('compares the VALUES');
  });
});

describe('generate mode: bad responses end as GENERATION_FAILED', () => {
  const expectFailed = async (reply: string | Error, message: RegExp) => {
    const result = await handlerFor(new FakeGemini([reply]))(generateEvent);

    expect(result.outcome).toBe('failed');
    expect(stored()?.testStatus).toBe('GENERATION_FAILED');
    expect(stored()?.testFailure).toMatch(message);
    // Nothing is left half-done for the worker.
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  };

  it('malformed JSON', () => expectFailed('{"signature": ', /malformed JSON/));
  it('prose instead of JSON', () => expectFailed('Sure! Here are your tests.', /malformed JSON/));
  it('6 small inputs', () =>
    expectFailed(validReply({ smallInputs: smallInputs.slice(0, 6) }), /6 small inputs/));
  it('8 small inputs', () =>
    expectFailed(
      validReply({ smallInputs: [...smallInputs, '{"nums":[9],"target":9}'] }),
      /8 small inputs/,
    ));
  it('no small inputs', () => expectFailed(validReply({ smallInputs: [] }), /0 small inputs/));
  it('an input with the wrong keys', () =>
    expectFailed(validReply({ smallInputs: [...smallInputs.slice(0, 6), '{"a":1}'] }), /has keys/));
  it('duplicate inputs', () =>
    expectFailed(
      validReply({ smallInputs: [...smallInputs.slice(0, 6), smallInputs[0]] }),
      /duplicate/,
    ));
  it('Gemini itself failing', () =>
    expectFailed(new Error('503 overloaded'), /Gemini request failed: 503 overloaded/));

  it('never stores the API key, even if an error message contains it', async () => {
    const result = await handlerFor(new FakeGemini([new Error(`bad request for key ${API_KEY}`)]))(
      generateEvent,
    );

    expect(result.outcome).toBe('failed');
    expect(stored()?.testFailure).not.toContain(API_KEY);
    expect(stored()?.testFailure).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('cuts very long reasons to 300 characters', async () => {
    await handlerFor(new FakeGemini([new Error('x'.repeat(2000))]))(generateEvent);
    expect(stored()?.testFailure?.length).toBeLessThanOrEqual(300);
  });

  it('a retry after a failure starts clean', async () => {
    await handlerFor(new FakeGemini(['nope']))(generateEvent);
    expect(stored()?.testStatus).toBe('GENERATION_FAILED');

    db.put('Questions', baseQuestion({ testAttempt: 2, testStatus: 'GENERATING' }));
    const result = await handlerFor(new FakeGemini([validReply()]))({
      ...generateEvent,
      attempt: 2,
    });

    expect(result).toEqual({ outcome: 'sent', attempt: 2 });
    expect(stored()?.testFailure).toBeUndefined();
  });

  it('fails when the model is still the placeholder', async () => {
    process.env['GEMINI_MODEL'] = '<GEMINI_MODEL>';
    const gemini = new FakeGemini([validReply()]);

    const result = await handlerFor(gemini)(generateEvent);

    expect(result.outcome).toBe('failed');
    expect(stored()?.testFailure).toMatch(/model is not configured/);
    expect(gemini.requests).toHaveLength(0);
  });

  it('fails when saving to S3 fails, and sends nothing', async () => {
    s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));

    const result = await handlerFor(new FakeGemini([validReply()]))(generateEvent);

    expect(result.outcome).toBe('failed');
    expect(stored()?.testStatus).toBe('GENERATION_FAILED');
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('fails when the queue send fails', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('queue gone'));

    const result = await handlerFor(new FakeGemini([validReply()]))(generateEvent);

    expect(result.outcome).toBe('failed');
    expect(stored()?.testStatus).toBe('GENERATION_FAILED');
  });
});

describe('generate mode: stale and odd events', () => {
  it('does nothing for a round that has been replaced', async () => {
    db.put('Questions', baseQuestion({ testAttempt: 2 }));
    const gemini = new FakeGemini([validReply()]);

    const result = await handlerFor(gemini)(generateEvent);

    expect(result).toEqual({ outcome: 'stale' });
    expect(gemini.requests).toHaveLength(0);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('does not let a round that was replaced mid-flight write files or send', async () => {
    const gemini = new FakeGemini([validReply()]);
    // The teacher edits the question while Gemini is thinking: the round moves on.
    const original = gemini.generateJson.bind(gemini);
    gemini.generateJson = async (request) => {
      const reply = await original(request);
      db.put('Questions', baseQuestion({ testAttempt: 2, testStatus: undefined }));
      return reply;
    };

    const result = await handlerFor(gemini)(generateEvent);

    expect(result).toEqual({ outcome: 'stale' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(stored()?.testStatus).toBeUndefined();
  });

  it('ignores a question that does not exist', async () => {
    const result = await handlerFor(new FakeGemini([]))({ ...generateEvent, questionId: 'nope' });
    expect(result).toMatchObject({ outcome: 'ignored' });
  });

  it.each([
    ['an empty event', {}],
    ['an unknown mode', { mode: 'dance', questionId: 'q1', version: 1, attempt: 1 }],
    ['a missing attempt', { mode: 'generate', questionId: 'q1', version: 1 }],
    ['a string version', { mode: 'generate', questionId: 'q1', version: '1', attempt: 1 }],
    ['null', null],
  ])('ignores %s', async (_label, event) => {
    expect(await handlerFor(new FakeGemini([]))(event)).toMatchObject({ outcome: 'ignored' });
  });

  it('fetches the API key once across invocations', async () => {
    const handler = handlerFor(new FakeGemini([validReply(), 'bad']));
    // Use the real key path: a handler whose deps ask for the key like production does.
    const { getGeminiApiKey } = await import('../lib/secret.js');
    await getGeminiApiKey();
    await handler(generateEvent);
    db.put('Questions', baseQuestion({ testAttempt: 2 }));
    await handler({ ...generateEvent, attempt: 2 });
    await getGeminiApiKey();

    expect(secrets.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});

describe('regenerate mode', () => {
  const currentSmall = smallInputs;
  const regenerateEvent = (indexes: number[], attempt = 2) => ({
    mode: 'regenerate',
    questionId: 'q1',
    version: 1,
    attempt,
    indexes,
    reason: 'Reference solution timed out',
  });
  const replacement = (index: number) => ({
    index,
    input: JSON.stringify({ nums: [500 + index], target: 500 + index }),
  });

  beforeEach(() => {
    // Round 2 of the question: the first full generation plus one replacement round so far.
    db.put('Questions', baseQuestion({ testAttempt: 2, testRegenerations: 1, signature }));
    const files: Record<string, string> = {
      'questions/q1/v1/reference.py': 'REFERENCE',
      'questions/q1/v1/generator.py': 'GENERATOR',
      'questions/q1/v1/small-inputs.json': JSON.stringify(currentSmall),
    };
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) => ({
      Body: { transformToString: async () => files[input.Key] ?? '' } as never,
    }));
  });

  it('replaces only the listed small inputs and starts the next round', async () => {
    const gemini = new FakeGemini([
      JSON.stringify({ replacements: [replacement(1), replacement(4)] }),
    ]);

    const result = await handlerFor(gemini)(regenerateEvent([1, 4]));

    expect(result).toEqual({ outcome: 'sent', attempt: 3 });

    const saved = JSON.parse(puts()['questions/q1/v1/small-inputs.json'] as string) as string[];
    expect(saved).toHaveLength(7);
    saved.forEach((input, i) => {
      if (i === 1 || i === 4) expect(input).toBe(replacement(i).input);
      else expect(input).toBe(currentSmall[i]);
    });
    expect(puts()).not.toHaveProperty(['questions/q1/v1/generator.py']);
    expect(puts()).not.toHaveProperty(['questions/q1/v1/reference.py']);

    const input = sqs.commandCalls(SendMessageCommand)[0]?.args[0].input;
    expect(input?.MessageDeduplicationId).toBe('setup#q1#1#3');
    const message = JSON.parse(input?.MessageBody as string);
    expect(message).toMatchObject({ type: 'SETUP', attempt: 3, smallInputs: saved });

    expect(stored()).toMatchObject({ testAttempt: 3, testStatus: 'GENERATING' });
  });

  it('shows Gemini the failed inputs and the current files', async () => {
    const gemini = new FakeGemini([JSON.stringify({ replacements: [replacement(2)] })]);

    await handlerFor(gemini)(regenerateEvent([2]));

    const [request] = gemini.requests;
    expect(request?.schema).toBe(REGENERATE_RESPONSE_SCHEMA);
    expect(request?.prompt).toContain('REFERENCE');
    expect(request?.prompt).toContain('GENERATOR');
    expect(request?.prompt).toContain(`2: ${currentSmall[2]}`);
    expect(request?.prompt).toContain('Reference solution timed out');
    expect(request?.prompt).not.toMatch(/\{\{|\}\}/);
  });

  it('rewrites the generator when a large input is listed', async () => {
    const gemini = new FakeGemini([
      JSON.stringify({ replacements: [], generatorScript: 'NEW GENERATOR' }),
    ]);

    const result = await handlerFor(gemini)(regenerateEvent([8]));

    expect(result).toEqual({ outcome: 'sent', attempt: 3 });
    expect(puts()['questions/q1/v1/generator.py']).toBe('NEW GENERATOR');
    expect(JSON.parse(puts()['questions/q1/v1/small-inputs.json'] as string)).toEqual(currentSmall);
  });

  it('handles a mix of small and large indexes', async () => {
    const gemini = new FakeGemini([
      JSON.stringify({ replacements: [replacement(0)], generatorScript: 'NEW GENERATOR' }),
    ]);

    await handlerFor(gemini)(regenerateEvent([9, 0]));

    expect(puts()['questions/q1/v1/generator.py']).toBe('NEW GENERATOR');
    expect(JSON.parse(puts()['questions/q1/v1/small-inputs.json'] as string)[0]).toBe(
      replacement(0).input,
    );
  });

  it.each([
    [
      'replacing an input that was not requested',
      { replacements: [replacement(1), replacement(2)] },
      [1],
      /replaced inputs \[1, 2\]/,
    ],
    [
      'not replacing a requested input',
      { replacements: [replacement(1)] },
      [1, 3],
      /were requested/,
    ],
    [
      'returning the same input again',
      { replacements: [{ index: 1, input: currentSmall[1] }] },
      [1],
      /same input again/,
    ],
    ['no generator for a large index', { replacements: [] }, [7], /corrected generator/],
  ])('fails on %s, without writing or sending', async (_label, reply, indexes, message) => {
    const result = await handlerFor(new FakeGemini([JSON.stringify(reply)]))(
      regenerateEvent(indexes),
    );

    expect(result.outcome).toBe('failed');
    expect(stored()).toMatchObject({ testStatus: 'GENERATION_FAILED', testAttempt: 2 });
    expect(stored()?.testFailure).toMatch(message);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('asks for replacements at most twice, then gives up', async () => {
    expect(MAX_REGENERATION_ROUNDS).toBe(2);
    db.put('Questions', baseQuestion({ testAttempt: 1, testRegenerations: 0, signature }));
    const gemini = new FakeGemini([
      JSON.stringify({ replacements: [replacement(1)] }),
      JSON.stringify({ replacements: [replacement(2)] }),
    ]);
    const handler = handlerFor(gemini);

    // First failure of the reference solution: attempt 1 -> 2.
    expect(await handler(regenerateEvent([1], 1))).toEqual({ outcome: 'sent', attempt: 2 });
    expect(stored()).toMatchObject({ testAttempt: 2, testRegenerations: 1 });

    // Second: attempt 2 -> 3.
    expect(await handler(regenerateEvent([2], 2))).toEqual({ outcome: 'sent', attempt: 3 });
    expect(stored()).toMatchObject({ testAttempt: 3, testRegenerations: 2 });

    // Third: give up. Gemini is not asked again and nothing is sent.
    const sentBefore = sqs.commandCalls(SendMessageCommand).length;
    const result = await handler(regenerateEvent([3], 3));

    expect(result.outcome).toBe('failed');
    expect(stored()).toMatchObject({ testStatus: 'GENERATION_FAILED', testAttempt: 3 });
    expect(stored()?.testFailure).toMatch(/after 2 rounds/);
    expect(gemini.requests).toHaveLength(2);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(sentBefore);
  });

  it('gives up straight away when two replacement rounds have already been used', async () => {
    db.put('Questions', baseQuestion({ testAttempt: 3, testRegenerations: 2, signature }));
    const gemini = new FakeGemini([JSON.stringify({ replacements: [replacement(1)] })]);

    const result = await handlerFor(gemini)(regenerateEvent([1], 3));

    expect(result.outcome).toBe('failed');
    expect(stored()?.testFailure).toMatch(/after 2 rounds of replacing inputs/);
    expect(gemini.requests).toHaveLength(0);
  });

  it("does not count a teacher's own retries as replacement rounds", async () => {
    // Six manual generate-tests clicks later: attempt 7, but no replacement has happened yet.
    db.put('Questions', baseQuestion({ testAttempt: 7, testRegenerations: 0, signature }));
    const gemini = new FakeGemini([JSON.stringify({ replacements: [replacement(1)] })]);

    expect(await handlerFor(gemini)(regenerateEvent([1], 7))).toEqual({
      outcome: 'sent',
      attempt: 8,
    });
  });

  it('counts a question that has no counter as zero replacements so far', async () => {
    db.put('Questions', baseQuestion({ testAttempt: 2, signature }));
    const gemini = new FakeGemini([JSON.stringify({ replacements: [replacement(1)] })]);

    expect((await handlerFor(gemini)(regenerateEvent([1]))).outcome).toBe('sent');
  });

  it('does nothing for a result from an older round', async () => {
    const gemini = new FakeGemini([JSON.stringify({ replacements: [replacement(1)] })]);

    const result = await handlerFor(gemini)(regenerateEvent([1], 1));

    expect(result).toEqual({ outcome: 'stale' });
    expect(gemini.requests).toHaveLength(0);
    expect(stored()?.testAttempt).toBe(2);
  });

  it('is stale if the round moves on while Gemini is thinking', async () => {
    const gemini = new FakeGemini([JSON.stringify({ replacements: [replacement(1)] })]);
    const original = gemini.generateJson.bind(gemini);
    gemini.generateJson = async (request) => {
      const reply = await original(request);
      db.put('Questions', baseQuestion({ testAttempt: 3, signature }));
      return reply;
    };

    expect(await handlerFor(gemini)(regenerateEvent([1]))).toEqual({ outcome: 'stale' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('fails if the question has no signature yet', async () => {
    db.put('Questions', baseQuestion({ testAttempt: 2 }));

    const result = await handlerFor(new FakeGemini([]))(regenerateEvent([1]));

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(stored()?.testFailure).toMatch(/no signature/);
  });

  it.each([
    ['no indexes', []],
    ['an index above 9', [10]],
    ['a negative index', [-1]],
    ['a fractional index', [1.5]],
  ])('ignores %s', async (_label, indexes) => {
    const result = await handlerFor(new FakeGemini([]))(regenerateEvent(indexes));
    expect(result).toMatchObject({ outcome: 'ignored' });
    expect(stored()?.testStatus).toBe('GENERATING');
  });

  it('ignores duplicate indexes', async () => {
    const result = await handlerFor(new FakeGemini([]))(regenerateEvent([1, 1]));
    expect(result).toMatchObject({ outcome: 'ignored' });
  });

  it('marks the new round as failed if sending fails after the round advanced', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('queue gone'));

    const result = await handlerFor(
      new FakeGemini([JSON.stringify({ replacements: [replacement(1)] })]),
    )(regenerateEvent([1]));

    expect(result.outcome).toBe('failed');
    expect(stored()).toMatchObject({ testStatus: 'GENERATION_FAILED', testAttempt: 3 });
  });
});

describe('a busy Gemini', () => {
  const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';
  const rateLimited = (retryDelay?: string) =>
    new GeminiApiError(
      429,
      JSON.stringify({
        error: {
          message: 'Quota exceeded',
          status: 'RESOURCE_EXHAUSTED',
          ...(retryDelay ? { details: [{ '@type': RETRY_INFO, retryDelay }] } : {}),
        },
      }),
    );
  const unavailable = () => new GeminiApiError(503, 'overloaded');
  const busy =
    (make: () => Error = () => rateLimited()) =>
    () =>
      [1, 2, 3, 4].map(make);

  const sleeps: number[] = [];
  const handler = (gemini: FakeGemini) =>
    createHandler({
      gemini: async () => gemini,
      prompt: () => loadPromptFile(PROMPT_FILE),
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
    });

  beforeEach(() => {
    sleeps.length = 0;
  });

  describe('retries inside one invocation', () => {
    it('waits the delay Google asks for after a 429, then succeeds', async () => {
      const gemini = new FakeGemini([rateLimited('20s'), validReply()]);

      const result = await handler(gemini)(generateEvent, {
        getRemainingTimeInMillis: () => 280_000,
      });

      expect(result).toEqual({ outcome: 'sent', attempt: 1 });
      expect(sleeps).toEqual([20_250]);
      expect(gemini.requests).toHaveLength(2);
      expect(gemini.requests.every((r) => r.timeoutMs === GEMINI_CALL_TIMEOUT_MS)).toBe(true);
    });

    it('backs off 2 s, 4 s, 8 s when Google gives no delay', async () => {
      const gemini = new FakeGemini([unavailable(), unavailable(), unavailable(), validReply()]);
      expect(await handler(gemini)(generateEvent)).toEqual({ outcome: 'sent', attempt: 1 });
      expect(sleeps).toEqual([2000, 4000, 8000]);
    });

    it("uses normal backoff when Google's delay does not fit in the time left", async () => {
      const gemini = new FakeGemini([rateLimited('200s'), validReply()]);
      await handler(gemini)(generateEvent, { getRemainingTimeInMillis: () => 250_000 });
      expect(sleeps).toEqual([2000]);
    });

    it('does not retry a 400', async () => {
      const gemini = new FakeGemini([new GeminiApiError(400, 'bad request'), validReply()]);
      const result = await handler(gemini)(generateEvent);
      expect(result.outcome).toBe('failed');
      expect(gemini.requests).toHaveLength(1);
      expect(stored()?.testStatus).toBe('GENERATION_FAILED');
    });
  });

  describe('still busy after those retries', () => {
    it('first time: counts it, keeps the question GENERATING and throws so Lambda runs it again', async () => {
      const gemini = new FakeGemini(busy()());

      await expect(handler(gemini)(generateEvent)).rejects.toThrow(GeminiBusyError);

      expect(gemini.requests).toHaveLength(4);
      expect(stored()).toMatchObject({ testStatus: 'GENERATING', testAttempt: 1, testGenTries: 1 });
      expect(stored()).not.toHaveProperty('testFailure');
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it('second time: still throws', async () => {
      db.put('Questions', baseQuestion({ testGenTries: 1 }));
      await expect(handler(new FakeGemini(busy()()))(generateEvent)).rejects.toThrow(
        GeminiBusyError,
      );
      expect(stored()).toMatchObject({ testStatus: 'GENERATING', testGenTries: 2 });
    });

    it('third time: GENERATION_FAILED with a plain reason, and no throw', async () => {
      db.put('Questions', baseQuestion({ testGenTries: MAX_BUSY_TRIES - 1 }));

      const result = await handler(new FakeGemini(busy()()))(generateEvent);

      expect(MAX_BUSY_TRIES).toBe(3);
      expect(result).toEqual({ outcome: 'failed', reason: BUSY_REASON });
      expect(stored()).toMatchObject({ testStatus: 'GENERATION_FAILED', testFailure: BUSY_REASON });
      expect(stored()).not.toHaveProperty('testGenTries');
    });

    it('runs through the three tries as Lambda would, the third failing the round', async () => {
      const run = () => handler(new FakeGemini(busy()()))(generateEvent);
      await expect(run()).rejects.toThrow(GeminiBusyError);
      await expect(run()).rejects.toThrow(GeminiBusyError);
      expect(await run()).toMatchObject({ outcome: 'failed', reason: BUSY_REASON });
    });

    it('succeeds when Gemini recovers on a later try', async () => {
      await expect(handler(new FakeGemini(busy()()))(generateEvent)).rejects.toThrow(
        GeminiBusyError,
      );
      const result = await handler(new FakeGemini([validReply()]))(generateEvent);

      expect(result).toEqual({ outcome: 'sent', attempt: 1 });
      expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(1);
    });

    it.each([
      ['503', unavailable],
      ['a timeout', () => Object.assign(new Error('t'), { name: 'AbortError' })],
    ])('treats %s like a rate limit', async (_name, make) => {
      await expect(handler(new FakeGemini(busy(make)()))(generateEvent)).rejects.toThrow(
        GeminiBusyError,
      );
      expect(stored()).toMatchObject({ testStatus: 'GENERATING', testGenTries: 1 });
    });

    it('stops retrying in the call when the Lambda is nearly out of time, and counts the try', async () => {
      const gemini = new FakeGemini([rateLimited(), validReply()]);
      await expect(
        handler(gemini)(generateEvent, { getRemainingTimeInMillis: () => 60_000 }),
      ).rejects.toThrow(GeminiBusyError);
      expect(gemini.requests).toHaveLength(1);
      expect(stored()?.testGenTries).toBe(1);
    });

    it('does not count or throw for a round that has been replaced', async () => {
      const gemini = new FakeGemini(busy()());
      const original = gemini.generateJson.bind(gemini);
      gemini.generateJson = async (request) => {
        db.put('Questions', baseQuestion({ testAttempt: 2 }));
        return original(request);
      };

      expect(await handler(gemini)(generateEvent)).toEqual({ outcome: 'stale' });
      expect(stored()).toMatchObject({ testAttempt: 2 });
      expect(stored()).not.toHaveProperty('testGenTries');
    });

    it('starts counting again in a new generation round', async () => {
      db.put('Questions', baseQuestion({ testGenTries: 2 }));
      expect(await questionsDb.beginGeneration('q1', 1)).toBe(2);
      expect(stored()).not.toHaveProperty('testGenTries');
    });
  });

  describe('failures that are not about Gemini being busy', () => {
    it.each([
      ['malformed JSON', ['{"signature": ']],
      ['a plain error', [new Error('boom')]],
      ['a 400', [new GeminiApiError(400, 'bad')]],
    ])('%s fails at once, never throws and is not counted', async (_name, replies) => {
      const result = await handler(new FakeGemini([...replies]))(generateEvent);

      expect(result.outcome).toBe('failed');
      expect(stored()?.testStatus).toBe('GENERATION_FAILED');
      expect(stored()).not.toHaveProperty('testGenTries');
    });
  });

  describe('regenerating inputs', () => {
    const regenerateEvent = {
      mode: 'regenerate',
      questionId: 'q1',
      version: 1,
      attempt: 2,
      indexes: [1],
      reason: 'timed out',
    };

    beforeEach(() => {
      db.put('Questions', baseQuestion({ testAttempt: 2, testRegenerations: 1, signature }));
      const files: Record<string, string> = {
        'questions/q1/v1/reference.py': 'REFERENCE',
        'questions/q1/v1/generator.py': 'GENERATOR',
        'questions/q1/v1/small-inputs.json': JSON.stringify(smallInputs),
      };
      s3.on(GetObjectCommand).callsFake((input: { Key: string }) => ({
        Body: { transformToString: async () => files[input.Key] ?? '' } as never,
      }));
    });

    it('honours the delay, then counts busy tries and throws twice', async () => {
      const gemini = new FakeGemini([
        rateLimited('5s'),
        rateLimited('5s'),
        rateLimited('5s'),
        rateLimited('5s'),
      ]);
      await expect(handler(gemini)(regenerateEvent)).rejects.toThrow(GeminiBusyError);
      expect(sleeps).toEqual([5250, 5250, 5250]);
      expect(stored()).toMatchObject({ testStatus: 'GENERATING', testAttempt: 2, testGenTries: 1 });
    });

    it('fails the round on the third busy try', async () => {
      db.put(
        'Questions',
        baseQuestion({ testAttempt: 2, testRegenerations: 1, signature, testGenTries: 2 }),
      );
      const result = await handler(new FakeGemini(busy()()))(regenerateEvent);
      expect(result).toEqual({ outcome: 'failed', reason: BUSY_REASON });
      expect(stored()?.testStatus).toBe('GENERATION_FAILED');
    });

    it('succeeds after a rate limit', async () => {
      const reply = JSON.stringify({
        replacements: [{ index: 1, input: JSON.stringify({ nums: [77], target: 77 }) }],
      });
      const result = await handler(new FakeGemini([rateLimited(), reply]))(regenerateEvent);
      expect(result).toEqual({ outcome: 'sent', attempt: 3 });
      expect(stored()).not.toHaveProperty('testGenTries');
    });
  });
});
