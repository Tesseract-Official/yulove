import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsumer } from './consumer.js';

const sqsMock = mockClient(SQSClient);
const s3Mock = mockClient(S3Client);

const EXECUTE_URL = 'https://sqs.example/execute.fifo';
const RESULTS_URL = 'https://sqs.example/results.fifo';
const BUCKET = 'bucket';

const TESTS = Array.from({ length: 10 }, (_, index) => ({
  index,
  kind: index < 7 ? 'small' : 'large',
  input: `{"n":${index}}`,
  expected: String(index),
}));
const TESTS_JSON = JSON.stringify({ questionId: 'q1', version: 1, tests: TESTS });

const answerBody = (overrides = {}) => ({
  type: 'ANSWER',
  examId: 'exam-1',
  studentEmail: 'student@college.edu',
  questionNumber: 2,
  attempt: 3,
  questionId: 'q1',
  version: 1,
  language: 'python',
  correctedCode: 'def solve(n): return n',
  driverCode: 'def solve(n): return n\nprint(1)',
  testsKey: 'questions/q1/v1/tests.json',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
  ...overrides,
});

const setupBody = (overrides = {}) => ({
  type: 'SETUP',
  questionId: 'q1',
  version: 1,
  attempt: 2,
  referenceKey: 'questions/q1/v1/reference.py',
  generatorKey: 'questions/q1/v1/generator.py',
  smallInputs: Array.from({ length: 7 }, (_, i) => `{"n":${i}}`),
  largeInputCount: 3,
  testsKey: 'questions/q1/v1/tests.json',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
  ...overrides,
});

let counter = 0;
function message(body, { group = 'exam-1#student@college.edu', dedup, receiveCount = 1 } = {}) {
  counter += 1;
  return {
    MessageId: `m${counter}`,
    ReceiptHandle: `receipt-${counter}`,
    Body: typeof body === 'string' ? body : JSON.stringify(body),
    Attributes: {
      MessageGroupId: group,
      MessageDeduplicationId: dedup ?? `exam-1#student@college.edu#2#${counter}`,
      ApproximateReceiveCount: String(receiveCount),
    },
  };
}

const text = (value) => ({ Body: { transformToString: async () => value } });
const serve = (key, value) =>
  s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: key }).resolves(text(value));

/** Receive hands out these batches in order, then waits (a long poll with nothing in it). */
function queue(...batches) {
  const waiting = () => new Promise(() => {});
  sqsMock.on(ReceiveMessageCommand).callsFake(async () => {
    const next = batches.shift();
    return next ? { Messages: next } : waiting();
  });
}

const sent = () => sqsMock.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
const deleted = () => sqsMock.commandCalls(DeleteMessageCommand).map((c) => c.args[0].input);
const sentBodies = () => sent().map((i) => JSON.parse(i.MessageBody));

function makeConsumer(overrides = {}) {
  const lines = [];
  const consumer = createConsumer({
    sqs: new SQSClient({ region: 'ap-south-1' }),
    s3: new S3Client({ region: 'ap-south-1' }),
    config: {
      executeQueueUrl: EXECUTE_URL,
      resultsQueueUrl: RESULTS_URL,
      bucket: BUCKET,
      concurrency: 4,
    },
    runJudge: vi.fn(async () => ({
      outcome: 'COMPLETED',
      verdicts: TESTS.map((t) => ({ index: t.index, kind: t.kind, verdict: 'AC' })),
    })),
    runSetup: vi.fn(async () => ({
      complete: true,
      failedInputIndexes: [],
      reasons: {},
      tests: TESTS,
    })),
    log: (entry) => lines.push(entry),
    receiveBackoffMs: 10,
    releaseWaitMs: 5,
    ...overrides,
  });
  return { consumer, lines };
}

/** Starts the consumer and returns a function that stops it and waits for it to finish. */
function start(consumer) {
  const running = consumer.run();
  return async () => {
    consumer.stop();
    await running;
  };
}

const settled = (predicate) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });

beforeEach(() => {
  sqsMock.reset();
  s3Mock.reset();
  sqsMock.on(SendMessageCommand).resolves({});
  sqsMock.on(DeleteMessageCommand).resolves({});
  sqsMock.on(ChangeMessageVisibilityCommand).resolves({});
  serve('questions/q1/v1/tests.json', TESTS_JSON);
});

afterEach(() => vi.useRealTimers());

describe('an ANSWER message', () => {
  it('downloads tests.json, judges the answer with the message’s code and limits, and sends the verdicts', async () => {
    const m = message(answerBody(), { dedup: 'exam-1#student@college.edu#2#3' });
    queue([m]);
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Key: 'questions/q1/v1/tests.json',
    });

    const [result] = sentBodies();
    expect(result).toMatchObject({
      type: 'ANSWER',
      examId: 'exam-1',
      studentEmail: 'student@college.edu',
      questionNumber: 2,
      attempt: 3,
      outcome: 'COMPLETED',
    });
    expect(result.verdicts).toHaveLength(10);
    expect(result.verdicts.every((v) => v.verdict === 'AC')).toBe(true);
  });

  it('passes the judge the code, driver, limits, all 10 tests in order, and a slot', async () => {
    const runJudge = vi.fn(async () => ({ outcome: 'COMPLETED', verdicts: [] }));
    // tests.json is stored out of order; the judge gets them sorted.
    serve('questions/q1/v1/tests.json', JSON.stringify({ tests: [...TESTS].reverse() }));
    queue([
      message(
        answerBody({ language: 'java', timeLimitMs: 1500, memoryMb: 128, compareMode: 'FLOAT' }),
      ),
    ]);
    const { consumer } = makeConsumer({ runJudge });
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(runJudge).toHaveBeenCalledTimes(1);
    const job = runJudge.mock.calls[0][0];
    expect(job).toMatchObject({
      language: 'java',
      driverCode: 'def solve(n): return n\nprint(1)',
      correctedCode: 'def solve(n): return n',
      timeLimitMs: 1500,
      memoryMb: 128,
      compareMode: 'FLOAT',
    });
    expect(job.slot).toBeGreaterThanOrEqual(1);
    expect(job.tests.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('reads tests.json from the message’s testsKey (a version may reuse another version’s file)', async () => {
    serve('questions/q1/v1/tests.json', TESTS_JSON);
    queue([message(answerBody({ version: 2, testsKey: 'questions/q1/v1/tests.json' }))]);
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input.Key).toBe(
      'questions/q1/v1/tests.json',
    );
    expect(sentBodies()[0].outcome).toBe('COMPLETED');
  });

  it('sends the result to the results queue with the incoming group id and the deduplication id plus :result, then deletes', async () => {
    const m = message(answerBody(), {
      group: 'exam-1#student@college.edu',
      dedup: 'exam-1#student@college.edu#2#3',
    });
    queue([m]);
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      QueueUrl: RESULTS_URL,
      MessageGroupId: 'exam-1#student@college.edu',
      MessageDeduplicationId: 'exam-1#student@college.edu#2#3:result',
    });
    expect(deleted()).toEqual([{ QueueUrl: EXECUTE_URL, ReceiptHandle: m.ReceiptHandle }]);

    // The result is sent before the execute message is deleted.
    const order = sqsMock.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf('SendMessageCommand')).toBeLessThan(order.indexOf('DeleteMessageCommand'));
  });

  it('reports a DRIVER_MISMATCH as a failed answer', async () => {
    queue([message(answerBody())]);
    const { consumer } = makeConsumer({
      runJudge: async () => ({ outcome: 'FAILED', failReason: 'DRIVER_MISMATCH' }),
    });
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(sentBodies()[0]).toMatchObject({
      type: 'ANSWER',
      outcome: 'FAILED',
      failReason: 'DRIVER_MISMATCH',
    });
  });

  it('keeps long deduplication ids within 128 characters', async () => {
    queue([message(answerBody(), { dedup: 'd'.repeat(125) })]);
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    const id = sent()[0].MessageDeduplicationId;
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id.endsWith(':result')).toBe(true);
  });
});

describe('a SETUP message', () => {
  const files = () => {
    serve('questions/q1/v1/reference.py', 'REFERENCE');
    serve('questions/q1/v1/generator.py', 'GENERATOR');
    serve('questions/q1/v1/small-inputs.json', JSON.stringify(setupBody().smallInputs));
  };

  it('downloads the files, runs setup, writes tests.json to testsKey, and sends OK', async () => {
    files();
    const runSetup = vi.fn(async () => ({
      complete: true,
      failedInputIndexes: [],
      reasons: {},
      tests: TESTS,
    }));
    const m = message(setupBody(), { group: 'setup#q1', dedup: 'setup#q1#1#2' });
    queue([m]);
    const { consumer } = makeConsumer({ runSetup });
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    const keys = s3Mock
      .commandCalls(GetObjectCommand)
      .map((c) => c.args[0].input.Key)
      .sort();
    expect(keys).toEqual([
      'questions/q1/v1/generator.py',
      'questions/q1/v1/reference.py',
      'questions/q1/v1/small-inputs.json',
    ]);

    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runSetup.mock.calls[0][0]).toMatchObject({
      referenceCode: 'REFERENCE',
      generatorCode: 'GENERATOR',
      smallInputs: setupBody().smallInputs,
      largeInputCount: 3,
      timeLimitMs: 2000,
      memoryMb: 256,
    });

    const puts = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ Bucket: BUCKET, Key: 'questions/q1/v1/tests.json' });
    expect(JSON.parse(puts[0].Body)).toEqual({ questionId: 'q1', version: 1, tests: TESTS });

    expect(sentBodies()[0]).toEqual({
      type: 'SETUP',
      questionId: 'q1',
      version: 1,
      attempt: 2,
      outcome: 'OK',
      testsKey: 'questions/q1/v1/tests.json',
      testCount: 10,
    });
    expect(sent()[0]).toMatchObject({
      MessageGroupId: 'setup#q1',
      MessageDeduplicationId: 'setup#q1#1#2:result',
    });
  });

  it('lists the failed input indexes and writes nothing when the reference solution fails', async () => {
    files();
    const runSetup = async () => ({
      complete: false,
      failedInputIndexes: [3, 8],
      reasons: {
        3: 'The reference solution crashed on input 3',
        8: 'The generator timed out for large input 1',
      },
      tests: [],
      testsFile: null,
    });
    queue([message(setupBody(), { group: 'setup#q1', dedup: 'setup#q1#1#2' })]);
    const { consumer } = makeConsumer({ runSetup });
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    const result = sentBodies()[0];
    expect(result).toMatchObject({
      type: 'SETUP',
      outcome: 'REFERENCE_FAILED',
      failedInputIndexes: [3, 8],
    });
    expect(result.reason).toContain('3: The reference solution crashed on input 3');
    expect(result.reason).toContain('8: The generator timed out');
  });

  it('uses the small inputs in the message when small-inputs.json does not exist', async () => {
    serve('questions/q1/v1/reference.py', 'REFERENCE');
    serve('questions/q1/v1/generator.py', 'GENERATOR');
    s3Mock
      .on(GetObjectCommand, { Bucket: BUCKET, Key: 'questions/q1/v1/small-inputs.json' })
      .rejects(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    const runSetup = vi.fn(async () => ({
      complete: true,
      failedInputIndexes: [],
      reasons: {},
      tests: TESTS,
    }));
    queue([message(setupBody())]);
    const { consumer } = makeConsumer({ runSetup });
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(runSetup.mock.calls[0][0].smallInputs).toEqual(setupBody().smallInputs);
    expect(sentBodies()[0].outcome).toBe('OK');
  });
});

describe('failures never leave a message to be retried', () => {
  const expectFailed = async (msg, expectation, options = {}) => {
    queue([msg]);
    const { consumer, lines } = makeConsumer(options);
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(sent()).toHaveLength(1);
    expect(sentBodies()[0]).toMatchObject(expectation);
    expect(deleted()).toEqual([{ QueueUrl: EXECUTE_URL, ReceiptHandle: msg.ReceiptHandle }]);
    return lines;
  };

  it('an unsupported language', () =>
    expectFailed(message(answerBody({ language: 'rust' })), {
      type: 'ANSWER',
      outcome: 'FAILED',
      failReason: 'UNSUPPORTED_LANGUAGE',
    }));

  it('an ANSWER with a missing field', () =>
    expectFailed(message(answerBody({ driverCode: undefined })), {
      type: 'ANSWER',
      outcome: 'FAILED',
      failReason: 'WORKER_ERROR',
      examId: 'exam-1',
    }));

  it('a SETUP with a missing field', () =>
    expectFailed(message(setupBody({ referenceKey: undefined })), {
      type: 'SETUP',
      outcome: 'FAILED',
      questionId: 'q1',
    }));

  it('S3 failing to give the tests', async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejects(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }));
    await expectFailed(message(answerBody()), {
      type: 'ANSWER',
      outcome: 'FAILED',
      failReason: 'WORKER_ERROR',
      detail: 'AccessDenied: Access Denied',
    });
  });

  it('a tests.json of the wrong shape', async () => {
    serve('questions/q1/v1/tests.json', JSON.stringify({ tests: TESTS.slice(0, 9) }));
    await expectFailed(message(answerBody()), { outcome: 'FAILED', failReason: 'WORKER_ERROR' });
  });

  it('a tests.json that is not JSON', async () => {
    serve('questions/q1/v1/tests.json', 'not json');
    await expectFailed(message(answerBody()), {
      outcome: 'FAILED',
      detail: 'tests.json is not valid JSON',
    });
  });

  it('the judge throwing', async () => {
    const lines = await expectFailed(
      message(answerBody()),
      {
        type: 'ANSWER',
        outcome: 'FAILED',
        failReason: 'WORKER_ERROR',
        detail: 'Error: sandbox exploded',
      },
      {
        runJudge: async () => {
          throw new Error('sandbox exploded');
        },
      },
    );
    expect(lines.some((l) => l.event === 'job-error')).toBe(true);
  });

  it('setup throwing', async () => {
    serve('questions/q1/v1/reference.py', 'R');
    serve('questions/q1/v1/generator.py', 'G');
    serve('questions/q1/v1/small-inputs.json', JSON.stringify(setupBody().smallInputs));
    await expectFailed(
      message(setupBody()),
      { type: 'SETUP', outcome: 'FAILED', reason: 'Error: no runner' },
      {
        runSetup: async () => {
          throw new Error('no runner');
        },
      },
    );
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('a SETUP whose testsKey is not a tests.json path', async () => {
    await expectFailed(message(setupBody({ testsKey: 'answers/exam/R1/q1.jpg' })), {
      type: 'SETUP',
      outcome: 'FAILED',
    });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('failing to write tests.json', async () => {
    serve('questions/q1/v1/reference.py', 'R');
    serve('questions/q1/v1/generator.py', 'G');
    serve('questions/q1/v1/small-inputs.json', JSON.stringify(setupBody().smallInputs));
    s3Mock.on(PutObjectCommand).rejects(new Error('disk full'));
    await expectFailed(message(setupBody()), {
      type: 'SETUP',
      outcome: 'FAILED',
      reason: 'Error: disk full',
    });
  });

  it('a message that is not JSON is dropped (there is nobody to tell)', async () => {
    const m = message('this is not json');
    queue([m]);
    const { consumer, lines } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(sent()).toHaveLength(0);
    expect(deleted()).toEqual([{ QueueUrl: EXECUTE_URL, ReceiptHandle: m.ReceiptHandle }]);
    expect(lines.some((l) => l.event === 'unreadable-message')).toBe(true);
    expect(lines.some((l) => l.event === 'job')).toBe(false);
  });

  it('a message with no identifying fields is dropped', async () => {
    const m = message({ type: 'ANSWER', language: 'python' });
    queue([m]);
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();
    expect(sent()).toHaveLength(0);
  });

  it('keeps going after a failure: the next message is still processed', async () => {
    queue([message(answerBody({ language: 'rust' })), message(answerBody())]);
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 2);
    await stop();
    expect(
      sentBodies()
        .map((r) => r.outcome)
        .sort(),
    ).toEqual(['COMPLETED', 'FAILED']);
  });
});

describe('a result that cannot be sent', () => {
  it('leaves the execute message alone so it is retried, and carries on', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('results queue unavailable'));
    const m = message(answerBody());
    queue([m]);
    const { consumer, lines } = makeConsumer();
    const stop = start(consumer);
    await settled(() => lines.some((l) => l.event === 'message-left-for-retry'));
    await stop();

    expect(deleted()).toHaveLength(0);
    expect(lines.find((l) => l.event === 'job')).toMatchObject({ leftForRetry: true });
  });
});

describe('concurrency', () => {
  /** A judge that holds each job until the test lets it go, and records how many ran at once. */
  function gatedJudge() {
    const state = { running: 0, peak: 0, slots: [], gates: [] };
    const runJudge = vi.fn(
      (job) =>
        new Promise((resolve) => {
          state.running += 1;
          state.peak = Math.max(state.peak, state.running);
          state.slots.push(job.slot);
          state.gates.push(() => {
            state.running -= 1;
            resolve({ outcome: 'COMPLETED', verdicts: [] });
          });
        }),
    );
    return { runJudge, state };
  }

  it('runs at most `concurrency` jobs at once, each in its own slot, and frees slots as jobs finish', async () => {
    const { runJudge, state } = gatedJudge();
    const first = [message(answerBody()), message(answerBody()), message(answerBody())];
    const second = [message(answerBody()), message(answerBody())];
    queue(first.slice(0, 2), first.slice(2), second);
    const { consumer } = makeConsumer({
      runJudge,
      config: {
        executeQueueUrl: EXECUTE_URL,
        resultsQueueUrl: RESULTS_URL,
        bucket: BUCKET,
        concurrency: 2,
      },
    });
    const stop = start(consumer);

    await settled(() => state.gates.length === 2);
    expect(state.running).toBe(2);
    expect(new Set(state.slots).size).toBe(2);
    expect(state.slots.every((s) => s === 1 || s === 2)).toBe(true);
    // Both slots are busy, so nothing else has started.
    await new Promise((r) => setTimeout(r, 30));
    expect(state.gates).toHaveLength(2);

    // Finish one job: the next message starts, in the slot that was freed.
    const freedSlot = state.slots[0];
    state.gates[0]();
    await settled(() => state.gates.length === 3);
    expect(state.slots[2]).toBe(freedSlot);

    while (deleted().length < 5) {
      state.gates.filter((_, i) => i >= 1).forEach((open) => open());
      await new Promise((r) => setTimeout(r, 10));
      if (state.gates.length >= 5 && state.running === 0) break;
    }
    await settled(() => deleted().length === 5);
    await stop();

    expect(state.peak).toBeLessThanOrEqual(2);
  });

  it('asks SQS for no more messages than there are free slots', async () => {
    const { runJudge, state } = gatedJudge();
    queue([message(answerBody()), message(answerBody())]);
    const { consumer } = makeConsumer({
      runJudge,
      config: {
        executeQueueUrl: EXECUTE_URL,
        resultsQueueUrl: RESULTS_URL,
        bucket: BUCKET,
        concurrency: 3,
      },
    });
    const stop = start(consumer);

    await settled(() => state.gates.length === 2);
    await settled(() => sqsMock.commandCalls(ReceiveMessageCommand).length >= 2);
    const asked = sqsMock
      .commandCalls(ReceiveMessageCommand)
      .map((c) => c.args[0].input.MaxNumberOfMessages);
    expect(asked[0]).toBe(3);
    expect(asked[1]).toBe(1); // two slots are busy
    state.gates.forEach((open) => open());
    await settled(() => deleted().length === 2);
    await stop();
  });

  it('long polls and asks for the attributes it needs', async () => {
    queue();
    const { consumer } = makeConsumer();
    const stop = start(consumer);
    await settled(() => sqsMock.commandCalls(ReceiveMessageCommand).length === 1);
    await stop();

    expect(sqsMock.commandCalls(ReceiveMessageCommand)[0].args[0].input).toEqual({
      QueueUrl: EXECUTE_URL,
      MaxNumberOfMessages: 4,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: [
        'MessageGroupId',
        'MessageDeduplicationId',
        'ApproximateReceiveCount',
      ],
    });
  });

  it('never asks for more than 10 messages', async () => {
    queue();
    const { consumer } = makeConsumer({
      config: {
        executeQueueUrl: EXECUTE_URL,
        resultsQueueUrl: RESULTS_URL,
        bucket: BUCKET,
        concurrency: 40,
      },
    });
    const stop = start(consumer);
    await settled(() => sqsMock.commandCalls(ReceiveMessageCommand).length === 1);
    await stop();
    expect(sqsMock.commandCalls(ReceiveMessageCommand)[0].args[0].input.MaxNumberOfMessages).toBe(
      10,
    );
  });

  it('backs off and tries again when a receive fails', async () => {
    let calls = 0;
    sqsMock.on(ReceiveMessageCommand).callsFake(async () => {
      calls += 1;
      if (calls === 1) throw new Error('throttled');
      if (calls === 2) return { Messages: [message(answerBody())] };
      return new Promise(() => {});
    });
    const { consumer, lines } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(lines.some((l) => l.event === 'receive-failed')).toBe(true);
  });
});

describe('visibility heartbeat', () => {
  it('extends the message’s visibility while a job runs, and stops when it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let finish;
    const runJudge = () =>
      new Promise((resolve) => (finish = () => resolve({ outcome: 'COMPLETED', verdicts: [] })));
    const m = message(answerBody());
    queue([m]);
    const { consumer } = makeConsumer({ runJudge });
    const stop = start(consumer);

    await settled(() => finish !== undefined);
    const heartbeats = () =>
      sqsMock.commandCalls(ChangeMessageVisibilityCommand).map((c) => c.args[0].input);
    expect(heartbeats()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0]).toEqual({
      QueueUrl: EXECUTE_URL,
      ReceiptHandle: m.ReceiptHandle,
      VisibilityTimeout: 600,
    });

    await vi.advanceTimersByTimeAsync(240_000);
    expect(heartbeats()).toHaveLength(3);

    finish();
    await settled(() => deleted().length === 1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(heartbeats()).toHaveLength(3); // none after the job ended
    await stop();
  });

  it('carries on if extending the visibility fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sqsMock.on(ChangeMessageVisibilityCommand).rejects(new Error('expired'));
    let finish;
    const runJudge = () =>
      new Promise((resolve) => (finish = () => resolve({ outcome: 'COMPLETED', verdicts: [] })));
    queue([message(answerBody())]);
    const { consumer, lines } = makeConsumer({ runJudge });
    const stop = start(consumer);

    await settled(() => finish !== undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    finish();
    await settled(() => deleted().length === 1);
    await stop();

    expect(lines.some((l) => l.event === 'heartbeat-failed')).toBe(true);
    expect(sentBodies()[0].outcome).toBe('COMPLETED');
  });
});

describe('stopping (SIGTERM)', () => {
  it('stops polling, lets running jobs finish, sends their results, deletes their messages, then returns', async () => {
    let finish;
    const runJudge = () =>
      new Promise((resolve) => (finish = () => resolve({ outcome: 'COMPLETED', verdicts: [] })));
    const m = message(answerBody());
    queue([m]);
    const { consumer, lines } = makeConsumer({ runJudge });
    let done = false;
    const running = consumer.run().then(() => (done = true));

    await settled(() => finish !== undefined);
    const receivesBefore = sqsMock.commandCalls(ReceiveMessageCommand).length;

    consumer.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false); // still waiting for the job
    expect(consumer.inFlight).toBe(1);
    expect(sent()).toHaveLength(0);

    finish();
    await running;

    expect(done).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(deleted()).toEqual([{ QueueUrl: EXECUTE_URL, ReceiptHandle: m.ReceiptHandle }]);
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(receivesBefore); // no new poll
    expect(lines.map((l) => l.event)).toEqual(
      expect.arrayContaining(['started', 'draining', 'stopped']),
    );
  });

  it('returns at once when nothing is running, even in the middle of a long poll', async () => {
    queue();
    const { consumer } = makeConsumer();
    const running = consumer.run();
    await settled(() => sqsMock.commandCalls(ReceiveMessageCommand).length === 1);

    consumer.stop();
    await expect(running).resolves.toBeUndefined();
  });

  it('gives back messages that arrive after the poll was cancelled', async () => {
    let deliver;
    sqsMock
      .on(ReceiveMessageCommand)
      .callsFake(() => new Promise((resolve) => (deliver = resolve)));
    const late = message(answerBody());
    const runJudge = vi.fn();
    const { consumer } = makeConsumer({ runJudge });
    const running = consumer.run();
    await settled(() => deliver !== undefined);

    consumer.stop();
    deliver({ Messages: [late] });
    await running;

    expect(runJudge).not.toHaveBeenCalled();
    const releases = sqsMock
      .commandCalls(ChangeMessageVisibilityCommand)
      .map((c) => c.args[0].input);
    expect(releases).toEqual([
      { QueueUrl: EXECUTE_URL, ReceiptHandle: late.ReceiptHandle, VisibilityTimeout: 0 },
    ]);
    expect(sent()).toHaveLength(0);
    expect(deleted()).toHaveLength(0);
  });

  it('can be stopped more than once', async () => {
    queue();
    const { consumer } = makeConsumer();
    const running = consumer.run();
    consumer.stop();
    consumer.stop();
    await expect(running).resolves.toBeUndefined();
  });
});

describe('the log', () => {
  it('writes one line per job with its keys, attempt, verdict summary and duration', async () => {
    const verdicts = TESTS.map((t, i) => ({
      index: t.index,
      kind: t.kind,
      verdict: i < 8 ? 'AC' : 'WA',
    }));
    queue([message(answerBody({ receiveCount: 2 }), { receiveCount: 2 })]);
    const { consumer, lines } = makeConsumer({
      runJudge: async () => ({ outcome: 'COMPLETED', verdicts }),
    });
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    const jobs = lines.filter((l) => l.event === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      level: 'info',
      event: 'job',
      type: 'ANSWER',
      examId: 'exam-1',
      studentEmail: 'student@college.edu',
      questionNumber: 2,
      attempt: 3,
      outcome: 'COMPLETED',
      summary: { AC: 8, WA: 2 },
      receiveCount: 2,
    });
    expect(typeof jobs[0].durationMs).toBe('number');
    expect(jobs[0].slot).toBeGreaterThanOrEqual(1);
  });

  it('logs a setup job by question and version', async () => {
    serve('questions/q1/v1/reference.py', 'R');
    serve('questions/q1/v1/generator.py', 'G');
    serve('questions/q1/v1/small-inputs.json', JSON.stringify(setupBody().smallInputs));
    queue([message(setupBody())]);
    const { consumer, lines } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(lines.find((l) => l.event === 'job')).toMatchObject({
      type: 'SETUP',
      questionId: 'q1',
      version: 1,
      attempt: 2,
      outcome: 'OK',
      summary: { tests: 10 },
    });
  });

  it('logs failed jobs with their reason', async () => {
    queue([message(answerBody({ language: 'rust' }))]);
    const { consumer, lines } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();

    expect(lines.find((l) => l.event === 'job')).toMatchObject({
      outcome: 'FAILED',
      summary: { failReason: 'UNSUPPORTED_LANGUAGE' },
    });
  });

  it('emits JSON-serialisable lines only', async () => {
    queue([message(answerBody())]);
    const { consumer, lines } = makeConsumer();
    const stop = start(consumer);
    await settled(() => deleted().length === 1);
    await stop();
    for (const line of lines) expect(() => JSON.stringify(line)).not.toThrow();
  });
});
