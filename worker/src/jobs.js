// What the worker does for each kind of message. Each handler returns { result, summary }: the
// ResultMsg to send and a small description of the outcome for the log line.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { posix } from 'node:path';
import { results, verdictSummary } from './contract.js';

export const TEST_COUNT = 10;

/** tests.json may only be written at questions/<id>/v<n>/tests.json. */
const TESTS_KEY = /^questions\/[^/]+\/v\d+\/tests\.json$/;

/** An error whose message is safe to put in a result (as opposed to an SDK error that may carry details). */
export class JobError extends Error {
  constructor(message, code = 'WORKER_ERROR') {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

export async function getText(s3, bucket, key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await out.Body?.transformToString('utf8')) ?? '';
}

export async function putText(s3, bucket, key, body) {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }),
  );
}

const isMissingKey = (error) => error?.name === 'NoSuchKey' || error?.name === 'NotFound';

/** Checks the shape of a tests.json and returns its tests in index order. */
export function parseTestsFile(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new JobError('tests.json is not valid JSON');
  }
  const tests = file?.tests;
  const wellFormed =
    Array.isArray(tests) &&
    tests.length === TEST_COUNT &&
    tests.every(
      (t) =>
        Number.isInteger(t?.index) &&
        t.index >= 0 &&
        t.index < TEST_COUNT &&
        (t.kind === 'small' || t.kind === 'large') &&
        typeof t.input === 'string' &&
        typeof t.expected === 'string',
    ) &&
    new Set(tests.map((t) => t.index)).size === TEST_COUNT;
  if (!wellFormed)
    throw new JobError(`tests.json must hold exactly ${TEST_COUNT} tests, one per index 0-9`);
  return [...tests].sort((a, b) => a.index - b.index);
}

/** ANSWER: judge the student's program against the question's tests. */
export async function handleAnswer(msg, { s3, bucket, runJudge, slot }) {
  const tests = parseTestsFile(await getText(s3, bucket, msg.testsKey));

  const outcome = await runJudge({
    language: msg.language,
    driverCode: msg.driverCode,
    correctedCode: msg.correctedCode,
    tests,
    timeLimitMs: msg.timeLimitMs,
    memoryMb: msg.memoryMb,
    compareMode: msg.compareMode,
    slot,
  });

  if (outcome.outcome === 'FAILED') {
    return {
      result: results.answerFailed(msg, outcome.failReason),
      summary: { failReason: outcome.failReason },
    };
  }
  return {
    result: results.answerCompleted(msg, outcome.verdicts),
    summary: verdictSummary(outcome.verdicts),
  };
}

/** The reasons for each failed input as one short text. */
function describeFailures(reasons) {
  return Object.entries(reasons)
    .map(([index, reason]) => `${index}: ${reason}`)
    .join('; ');
}

/** SETUP: run the generator and the reference solution, and write tests.json if every input worked. */
export async function handleSetup(msg, { s3, bucket, runSetup, slot }) {
  if (!TESTS_KEY.test(msg.testsKey)) {
    throw new JobError(
      `testsKey must look like questions/<id>/v<n>/tests.json, got ${msg.testsKey}`,
    );
  }
  if (msg.smallInputs.length + msg.largeInputCount !== TEST_COUNT) {
    throw new JobError(
      `A question needs ${TEST_COUNT} inputs, the message describes ${msg.smallInputs.length + msg.largeInputCount}`,
    );
  }

  const [referenceCode, generatorCode] = await Promise.all([
    getText(s3, bucket, msg.referenceKey),
    getText(s3, bucket, msg.generatorKey),
  ]);

  // The small inputs live next to the reference solution; the message carries a copy too.
  let smallInputs = msg.smallInputs;
  try {
    const stored = JSON.parse(
      await getText(s3, bucket, posix.join(posix.dirname(msg.referenceKey), 'small-inputs.json')),
    );
    if (!Array.isArray(stored) || stored.some((s) => typeof s !== 'string')) {
      throw new JobError('small-inputs.json must be a list of strings');
    }
    smallInputs = stored;
  } catch (error) {
    if (!isMissingKey(error)) throw error;
  }
  if (smallInputs.length !== msg.smallInputs.length) {
    throw new JobError(
      `small-inputs.json has ${smallInputs.length} inputs, the message says ${msg.smallInputs.length}`,
    );
  }

  const outcome = await runSetup({
    referenceCode,
    generatorCode,
    smallInputs,
    largeInputCount: msg.largeInputCount,
    timeLimitMs: msg.timeLimitMs,
    memoryMb: msg.memoryMb,
    slot,
  });

  if (!outcome.complete) {
    return {
      result: results.setupReferenceFailed(
        msg,
        outcome.failedInputIndexes,
        describeFailures(outcome.reasons),
      ),
      summary: { failedInputIndexes: outcome.failedInputIndexes },
    };
  }

  await putText(
    s3,
    bucket,
    msg.testsKey,
    JSON.stringify({ questionId: msg.questionId, version: msg.version, tests: outcome.tests }),
  );
  return {
    result: results.setupOk(msg, msg.testsKey, outcome.tests.length),
    summary: { tests: outcome.tests.length },
  };
}
