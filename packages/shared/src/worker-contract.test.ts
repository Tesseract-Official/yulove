// The execution worker is plain JavaScript and cannot import this package, so it mirrors the queue
// message contract in worker/src/contract.js. This test keeps the two in step: they must accept and
// reject the same messages, build results the shared schemas accept, and list the same values.
import { describe, expect, it } from 'vitest';
import { COMPARE_MODES, FAIL_REASONS, LANGUAGES, VERDICTS } from './enums.js';
import { executeMsg, resultMsg } from './messages.js';

interface WorkerContract {
  LANGUAGES: string[];
  COMPARE_MODES: string[];
  VERDICTS: string[];
  FAIL_REASONS: string[];
  MAX_DETAIL_CHARS: number;
  parseExecuteMsg(body: unknown): { ok: boolean; msg?: Record<string, unknown>; code?: string };
  results: Record<string, (...args: unknown[]) => unknown>;
}

const contractUrl = new URL('../../../worker/src/contract.js', import.meta.url).href;
const worker = (await import(/* @vite-ignore */ contractUrl)) as WorkerContract;

const answer = {
  type: 'ANSWER',
  examId: 'exam-1',
  studentEmail: 'student@college.edu',
  questionNumber: 2,
  attempt: 3,
  questionId: 'q1',
  version: 1,
  language: 'python',
  correctedCode: 'def solve(): pass',
  driverCode: 'def solve(): pass\nprint(1)',
  testsKey: 'questions/q1/v1/tests.json',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
};

const setup = {
  type: 'SETUP',
  questionId: 'q1',
  version: 1,
  attempt: 2,
  referenceKey: 'questions/q1/v1/reference.py',
  generatorKey: 'questions/q1/v1/generator.py',
  smallInputs: Array(7).fill('{"n":1}'),
  largeInputCount: 3,
  testsKey: 'questions/q1/v1/tests.json',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
};

/** A valid message plus many near-misses: every field removed, or given a wrong value. */
function variants(valid: Record<string, unknown>) {
  const out: Array<[string, unknown]> = [['valid', valid]];
  const wrongValues: unknown[] = [
    undefined,
    null,
    '',
    ' ',
    0,
    -1,
    1.5,
    1,
    'x',
    true,
    [],
    {},
    ['a'],
    [1],
  ];
  for (const field of Object.keys(valid)) {
    for (const value of wrongValues) {
      out.push([`${field} = ${JSON.stringify(value) ?? 'missing'}`, { ...valid, [field]: value }]);
    }
  }
  out.push(['an extra field', { ...valid, extra: 'x' }]);
  return out;
}

describe('the worker’s mirror of the contract', () => {
  it.each([
    ['languages', worker.LANGUAGES, LANGUAGES],
    ['compare modes', worker.COMPARE_MODES, COMPARE_MODES],
    ['verdicts', worker.VERDICTS, VERDICTS],
    ['fail reasons', worker.FAIL_REASONS, FAIL_REASONS],
  ])('lists the same %s', (_name, mirrored, shared) => {
    expect([...mirrored].sort()).toEqual([...shared].sort());
  });

  describe.each([
    ['ANSWER', answer],
    ['SETUP', setup],
  ])('parsing an %s message', (_type, valid) => {
    it.each(variants(valid))('agrees with the shared schema: %s', (_label, message) => {
      const mirrored = worker.parseExecuteMsg(message);
      const shared = executeMsg.safeParse(message);

      expect(mirrored.ok).toBe(shared.success);
      if (shared.success) expect(mirrored.msg).toEqual(shared.data);
    });

    it('agrees when the message arrives as JSON text', () => {
      const text = JSON.stringify(valid);
      expect(worker.parseExecuteMsg(text).ok).toBe(executeMsg.safeParse(JSON.parse(text)).success);
    });
  });

  it.each(LANGUAGES)('accepts the language %s like the shared schema', (language) => {
    expect(worker.parseExecuteMsg({ ...answer, language }).ok).toBe(true);
    expect(executeMsg.safeParse({ ...answer, language }).success).toBe(true);
  });

  it.each(COMPARE_MODES)('accepts the compare mode %s like the shared schema', (compareMode) => {
    expect(worker.parseExecuteMsg({ ...answer, compareMode }).ok).toBe(true);
    expect(executeMsg.safeParse({ ...answer, compareMode }).success).toBe(true);
  });

  describe('the results it builds are accepted by the shared schema', () => {
    const answerRef = { ...answer };
    const setupRef = { ...setup };
    const verdicts = [
      { index: 0, kind: 'small', verdict: 'AC' },
      { index: 1, kind: 'small', verdict: 'WA', input: '{}', expected: '1', actual: '2' },
      { index: 7, kind: 'large', verdict: 'TLE' },
    ];

    it('ANSWER completed', () => {
      expect(
        resultMsg.safeParse(worker.results.answerCompleted!(answerRef, verdicts)).success,
      ).toBe(true);
    });

    it.each(FAIL_REASONS)('ANSWER failed with %s, with and without a detail', (reason) => {
      expect(resultMsg.safeParse(worker.results.answerFailed!(answerRef, reason)).success).toBe(
        true,
      );
      expect(
        resultMsg.safeParse(worker.results.answerFailed!(answerRef, reason, 'because')).success,
      ).toBe(true);
      const long = worker.results.answerFailed!(answerRef, reason, 'x'.repeat(2000));
      expect(resultMsg.safeParse(long).success).toBe(true);
    });

    it('SETUP ok, reference failed, and failed', () => {
      expect(
        resultMsg.safeParse(worker.results.setupOk!(setupRef, 'questions/q1/v1/tests.json', 10))
          .success,
      ).toBe(true);
      expect(
        resultMsg.safeParse(worker.results.setupReferenceFailed!(setupRef, [3, 8], 'timed out'))
          .success,
      ).toBe(true);
      expect(
        resultMsg.safeParse(worker.results.setupReferenceFailed!(setupRef, [], 'x'.repeat(2000)))
          .success,
      ).toBe(true);
      expect(
        resultMsg.safeParse(worker.results.setupFailed!(setupRef, 'S3 was down')).success,
      ).toBe(true);
      expect(
        resultMsg.safeParse(worker.results.setupFailed!(setupRef, 'y'.repeat(2000))).success,
      ).toBe(true);
    });

    it('keeps the incoming reference fields and nothing else from the message', () => {
      const result = worker.results.answerFailed!(answerRef, 'WORKER_ERROR') as Record<
        string,
        unknown
      >;
      expect(Object.keys(result).sort()).toEqual(
        [
          'attempt',
          'examId',
          'failReason',
          'outcome',
          'questionNumber',
          'studentEmail',
          'type',
        ].sort(),
      );
    });
  });

  it('would notice a result that breaks the contract', () => {
    expect(resultMsg.safeParse({ type: 'ANSWER', outcome: 'FAILED' }).success).toBe(false);
    expect(resultMsg.safeParse({ type: 'SETUP', outcome: 'FAILED' }).success).toBe(false);
  });
});
