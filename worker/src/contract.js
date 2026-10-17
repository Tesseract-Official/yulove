// The queue messages the worker reads and writes, mirrored from @yulove/shared (the worker is plain
// JavaScript and does not import the TypeScript package). packages/shared/src/worker-contract.test.ts
// checks that this file and the shared zod schemas accept and reject the same messages and list
// the same values, so the two cannot drift apart unnoticed.
import { createHash } from 'node:crypto';

export const LANGUAGES = ['python', 'cpp', 'java', 'go'];
export const COMPARE_MODES = ['EXACT', 'ANY_ORDER', 'FLOAT'];
export const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];
export const FAIL_REASONS = [
  'UNREADABLE',
  'UNSUPPORTED_LANGUAGE',
  'GEMINI_ERROR',
  'WORKER_ERROR',
  'DRIVER_MISMATCH',
];

export const MAX_DETAIL_CHARS = 300;
export const MAX_SETUP_REASON_CHARS = 500;

/** SQS FIFO ids are at most 128 characters. */
const MAX_FIFO_ID_LENGTH = 128;
const RESULT_SUFFIX = ':result';

const isString = (v) => typeof v === 'string' && v.length > 0;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

/** field name -> [check, description] for the fields shared by every message of one kind. */
const ANSWER_REF = {
  examId: isString,
  studentEmail: isString,
  questionNumber: isPositiveInt,
  attempt: isPositiveInt,
};
const SETUP_REF = {
  questionId: isString,
  version: isPositiveInt,
  attempt: isPositiveInt,
};
const LIMITS = {
  timeLimitMs: isPositiveInt,
  memoryMb: isPositiveInt,
  compareMode: (v) => COMPARE_MODES.includes(v),
};
const ANSWER_FIELDS = {
  ...ANSWER_REF,
  questionId: isString,
  version: isPositiveInt,
  language: (v) => LANGUAGES.includes(v),
  correctedCode: isString,
  driverCode: isString,
  testsKey: isString,
  ...LIMITS,
};
const SETUP_FIELDS = {
  ...SETUP_REF,
  referenceKey: isString,
  generatorKey: isString,
  smallInputs: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  largeInputCount: isNonNegativeInt,
  testsKey: isString,
  ...LIMITS,
};

const invalidFields = (raw, fields) =>
  Object.entries(fields)
    .filter(([name, check]) => !check(raw[name]))
    .map(([name]) => name);

/** The fields that say whose job this is, taken from a message that may be otherwise invalid. */
function identify(raw) {
  if (raw?.type === 'ANSWER' && invalidFields(raw, ANSWER_REF).length === 0) {
    return { type: 'ANSWER', ref: pick(raw, ANSWER_REF) };
  }
  if (raw?.type === 'SETUP' && invalidFields(raw, SETUP_REF).length === 0) {
    return { type: 'SETUP', ref: pick(raw, SETUP_REF) };
  }
  return null;
}

const pick = (raw, fields) => Object.fromEntries(Object.keys(fields).map((k) => [k, raw[k]]));

/**
 * Parses and validates an ExecuteMsg (the same rules as the shared zod schema).
 *   { ok: true, msg }
 *   { ok: false, error, code, partial }  `code` is a fail reason; `partial` says whose job it was
 *                                        ({type, ref}) when that can be told, otherwise null.
 */
export function parseExecuteMsg(body) {
  let raw;
  try {
    raw = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return {
      ok: false,
      error: 'The message is not valid JSON',
      code: 'WORKER_ERROR',
      partial: null,
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'The message is not a JSON object',
      code: 'WORKER_ERROR',
      partial: null,
    };
  }

  const fields = raw.type === 'ANSWER' ? ANSWER_FIELDS : raw.type === 'SETUP' ? SETUP_FIELDS : null;
  if (!fields) {
    return {
      ok: false,
      error: `Unknown message type ${JSON.stringify(raw.type)}`,
      code: 'WORKER_ERROR',
      partial: null,
    };
  }

  const bad = invalidFields(raw, fields);
  if (bad.length === 0) return { ok: true, msg: pick(raw, { type: null, ...fields }) };

  const onlyLanguage =
    raw.type === 'ANSWER' && bad.length === 1 && bad[0] === 'language' && isString(raw.language);
  return {
    ok: false,
    error: `Invalid ${raw.type} message: ${bad.join(', ')}`,
    code: onlyLanguage ? 'UNSUPPORTED_LANGUAGE' : 'WORKER_ERROR',
    partial: identify(raw),
  };
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** ResultMsg builders. `msg` is any object that has the job's reference fields. */
export const results = {
  answerCompleted: (msg, verdicts) => ({
    type: 'ANSWER',
    ...pick(msg, ANSWER_REF),
    outcome: 'COMPLETED',
    verdicts,
  }),
  answerFailed: (msg, failReason, detail) => ({
    type: 'ANSWER',
    ...pick(msg, ANSWER_REF),
    outcome: 'FAILED',
    failReason,
    ...(detail ? { detail: cut(String(detail), MAX_DETAIL_CHARS) } : {}),
  }),
  setupOk: (msg, testsKey, testCount) => ({
    type: 'SETUP',
    ...pick(msg, SETUP_REF),
    outcome: 'OK',
    testsKey,
    testCount,
  }),
  setupReferenceFailed: (msg, failedInputIndexes, reason) => ({
    type: 'SETUP',
    ...pick(msg, SETUP_REF),
    outcome: 'REFERENCE_FAILED',
    failedInputIndexes,
    reason: cut(String(reason), MAX_SETUP_REASON_CHARS),
  }),
  setupFailed: (msg, reason) => ({
    type: 'SETUP',
    ...pick(msg, SETUP_REF),
    outcome: 'FAILED',
    reason: cut(String(reason), MAX_SETUP_REASON_CHARS),
  }),
};

/** A failed ResultMsg for a job of this type (`partial` from parseExecuteMsg or a valid msg). */
export function failedResult(type, ref, code, detail) {
  return type === 'ANSWER'
    ? results.answerFailed(ref, code, detail)
    : results.setupFailed(ref, detail ?? code);
}

/**
 * The result's deduplication id: the incoming id plus ":result". If that would be longer than SQS
 * allows, the front of the id is kept and a hash of the whole id is added, so it stays unique.
 */
export function resultDeduplicationId(incoming) {
  if (incoming.length + RESULT_SUFFIX.length <= MAX_FIFO_ID_LENGTH)
    return `${incoming}${RESULT_SUFFIX}`;
  const hash = createHash('sha256').update(incoming).digest('hex').slice(0, 16);
  const keep = MAX_FIFO_ID_LENGTH - RESULT_SUFFIX.length - 1 - hash.length;
  return `${incoming.slice(0, keep)}~${hash}${RESULT_SUFFIX}`;
}

/** Counts of each verdict, e.g. { AC: 8, WA: 2 }, for the log line. */
export function verdictSummary(verdicts) {
  const counts = {};
  for (const { verdict } of verdicts) counts[verdict] = (counts[verdict] ?? 0) + 1;
  return counts;
}
