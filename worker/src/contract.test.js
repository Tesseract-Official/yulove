import { describe, expect, it } from 'vitest';
import {
  failedResult,
  parseExecuteMsg,
  resultDeduplicationId,
  results,
  verdictSummary,
} from './contract.js';

const answer = (overrides = {}) => ({
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
  ...overrides,
});

const setup = (overrides = {}) => ({
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
  ...overrides,
});

describe('parseExecuteMsg', () => {
  it('accepts valid ANSWER and SETUP messages, as an object or as JSON text', () => {
    expect(parseExecuteMsg(answer())).toEqual({ ok: true, msg: answer() });
    expect(parseExecuteMsg(JSON.stringify(setup()))).toEqual({ ok: true, msg: setup() });
  });

  it('drops fields it does not know', () => {
    const parsed = parseExecuteMsg(answer({ extra: 'x' }));
    expect(parsed.ok).toBe(true);
    expect(parsed.msg).not.toHaveProperty('extra');
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[1]'],
    ['null', 'null'],
    ['a number', '5'],
    ['no type', JSON.stringify({ examId: 'e' })],
    ['an unknown type', JSON.stringify({ type: 'DANCE' })],
  ])('rejects %s, with nobody to tell', (_label, body) => {
    const parsed = parseExecuteMsg(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBeNull();
    expect(parsed.code).toBe('WORKER_ERROR');
  });

  it.each([
    ['a missing driver', answer({ driverCode: undefined })],
    ['an empty driver', answer({ driverCode: '' })],
    ['a string version', answer({ version: '1' })],
    ['an unknown compare mode', answer({ compareMode: 'LOOSE' })],
    ['a zero time limit', answer({ timeLimitMs: 0 })],
  ])('rejects an ANSWER with %s but still knows whose it is', (_label, msg) => {
    const parsed = parseExecuteMsg(msg);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('WORKER_ERROR');
    expect(parsed.partial).toMatchObject({ type: 'ANSWER' });
  });

  it('calls an unsupported language by its own fail reason', () => {
    const parsed = parseExecuteMsg(answer({ language: 'rust' }));
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('UNSUPPORTED_LANGUAGE');
    expect(parsed.partial.ref).toEqual({
      examId: 'exam-1',
      studentEmail: 'student@college.edu',
      questionNumber: 2,
      attempt: 3,
    });
  });

  it('does not call it an unsupported language when something else is also wrong', () => {
    expect(parseExecuteMsg(answer({ language: 'rust', driverCode: '' })).code).toBe('WORKER_ERROR');
  });

  it.each([
    ['too few small inputs field', setup({ smallInputs: 'x' })],
    ['a negative large input count', setup({ largeInputCount: -1 })],
    ['a missing reference key', setup({ referenceKey: undefined })],
    ['a missing tests key', setup({ testsKey: '' })],
  ])('rejects a SETUP with %s but still knows whose it is', (_label, msg) => {
    const parsed = parseExecuteMsg(msg);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toMatchObject({
      type: 'SETUP',
      ref: { questionId: 'q1', version: 1, attempt: 2 },
    });
  });

  it('has nobody to tell when the identifying fields are what is wrong', () => {
    expect(parseExecuteMsg(answer({ examId: undefined })).partial).toBeNull();
    expect(parseExecuteMsg(setup({ attempt: 0 })).partial).toBeNull();
    expect(parseExecuteMsg(answer({ attempt: 0 })).partial).toBeNull();
    expect(parseExecuteMsg(answer({ questionNumber: 1.5 })).partial).toBeNull();
  });
});

describe('result builders', () => {
  const ref = {
    examId: 'e',
    studentEmail: 's@c.edu',
    questionNumber: 1,
    attempt: 2,
    driverCode: 'x',
    language: 'python',
  };
  const setupRef = { questionId: 'q', version: 3, attempt: 4, referenceKey: 'k' };

  it('builds the ANSWER results with only the reference fields', () => {
    expect(results.answerCompleted(ref, [{ index: 0, kind: 'small', verdict: 'AC' }])).toEqual({
      type: 'ANSWER',
      examId: 'e',
      studentEmail: 's@c.edu',
      questionNumber: 1,
      attempt: 2,
      outcome: 'COMPLETED',
      verdicts: [{ index: 0, kind: 'small', verdict: 'AC' }],
    });
    expect(results.answerFailed(ref, 'DRIVER_MISMATCH')).toEqual({
      type: 'ANSWER',
      examId: 'e',
      studentEmail: 's@c.edu',
      questionNumber: 1,
      attempt: 2,
      outcome: 'FAILED',
      failReason: 'DRIVER_MISMATCH',
    });
  });

  it('cuts a failure detail to 300 characters', () => {
    const result = results.answerFailed(ref, 'WORKER_ERROR', 'x'.repeat(1000));
    expect(result.detail).toHaveLength(300);
  });

  it('builds the SETUP results', () => {
    expect(results.setupOk(setupRef, 'questions/q/v3/tests.json', 10)).toEqual({
      type: 'SETUP',
      questionId: 'q',
      version: 3,
      attempt: 4,
      outcome: 'OK',
      testsKey: 'questions/q/v3/tests.json',
      testCount: 10,
    });
    expect(results.setupReferenceFailed(setupRef, [3, 8], 'timed out')).toMatchObject({
      outcome: 'REFERENCE_FAILED',
      failedInputIndexes: [3, 8],
      reason: 'timed out',
    });
    expect(results.setupFailed(setupRef, 'S3 was down')).toMatchObject({
      outcome: 'FAILED',
      reason: 'S3 was down',
    });
    expect(results.setupFailed(setupRef, 'y'.repeat(2000)).reason).toHaveLength(500);
  });

  it('builds a failed result of the right type for either kind of job', () => {
    expect(failedResult('ANSWER', ref, 'WORKER_ERROR', 'boom')).toMatchObject({
      outcome: 'FAILED',
      failReason: 'WORKER_ERROR',
      detail: 'boom',
    });
    expect(failedResult('SETUP', setupRef, 'WORKER_ERROR', 'boom')).toMatchObject({
      outcome: 'FAILED',
      reason: 'boom',
    });
  });
});

describe('resultDeduplicationId', () => {
  it('adds :result', () => {
    expect(resultDeduplicationId('exam#s@c.edu#1#2')).toBe('exam#s@c.edu#1#2:result');
  });

  it('stays within 128 characters, exactly at the edge', () => {
    expect(resultDeduplicationId('a'.repeat(121))).toHaveLength(128);
    expect(resultDeduplicationId('a'.repeat(121))).toBe(`${'a'.repeat(121)}:result`);
  });

  it.each([122, 125, 128])(
    'shortens an id of %i characters but keeps it unique and ending in :result',
    (n) => {
      const id = resultDeduplicationId('a'.repeat(n));
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id.endsWith(':result')).toBe(true);
      expect(id).not.toBe(resultDeduplicationId(`${'a'.repeat(n - 1)}b`));
    },
  );

  it('is repeatable for the same id', () => {
    expect(resultDeduplicationId('x'.repeat(128))).toBe(resultDeduplicationId('x'.repeat(128)));
  });
});

describe('verdictSummary', () => {
  it('counts each verdict', () => {
    expect(
      verdictSummary([{ verdict: 'AC' }, { verdict: 'AC' }, { verdict: 'WA' }, { verdict: 'TLE' }]),
    ).toEqual({ AC: 2, WA: 1, TLE: 1 });
    expect(verdictSummary([])).toEqual({});
  });
});
