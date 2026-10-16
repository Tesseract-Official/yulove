import { describe, expect, it } from 'vitest';
import {
  executeMsg,
  messageDeduplicationId,
  messageGroupId,
  resultMsg,
  setupDeduplicationId,
  setupGroupId,
  transcribeMsg,
} from './messages.js';

describe('FIFO ids', () => {
  it('group id is exam + student', () => {
    expect(messageGroupId('exam-1', 'Student@College.edu')).toBe('exam-1#student@college.edu');
  });

  it('deduplication id is exam + student + question + attempt', () => {
    expect(messageDeduplicationId('exam-1', 'student@college.edu', 3, 2)).toBe(
      'exam-1#student@college.edu#3#2',
    );
  });

  it('deduplication id changes with the attempt and the question', () => {
    const base = messageDeduplicationId('e', 's@c.edu', 1, 1);
    expect(messageDeduplicationId('e', 's@c.edu', 1, 2)).not.toBe(base);
    expect(messageDeduplicationId('e', 's@c.edu', 2, 1)).not.toBe(base);
  });

  it('throws rather than build an id longer than SQS allows', () => {
    expect(() => messageGroupId('e'.repeat(100), `${'s'.repeat(40)}@college.edu`)).toThrow(/128/);
    expect(() => messageDeduplicationId('e'.repeat(100), 's'.repeat(30), 1, 1)).toThrow(/128/);
  });

  it('setup ids group by question and include the generation round', () => {
    expect(setupGroupId('q-1')).toBe('setup#q-1');
    expect(setupDeduplicationId('q-1', 2, 3)).toBe('setup#q-1#2#3');
  });
});

const answerRef = { examId: 'e1', studentEmail: 's@college.edu', questionNumber: 1, attempt: 1 };

describe('transcribeMsg', () => {
  it('accepts a complete message', () => {
    expect(transcribeMsg.safeParse({ ...answerRef, questionId: 'q1', version: 1 }).success).toBe(
      true,
    );
  });

  it.each([
    [
      'missing attempt',
      { examId: 'e1', studentEmail: 's@c.edu', questionNumber: 1, questionId: 'q', version: 1 },
    ],
    ['attempt 0', { ...answerRef, attempt: 0, questionId: 'q', version: 1 }],
    ['string question number', { ...answerRef, questionNumber: '1', questionId: 'q', version: 1 }],
  ])('rejects %s', (_label, message) => {
    expect(transcribeMsg.safeParse(message).success).toBe(false);
  });
});

describe('executeMsg', () => {
  const limits = { timeLimitMs: 2000, memoryMb: 256, compareMode: 'EXACT' };

  it('accepts an ANSWER message and narrows on type', () => {
    const parsed = executeMsg.parse({
      type: 'ANSWER',
      ...answerRef,
      questionId: 'q1',
      version: 1,
      language: 'python',
      correctedCode: 'def f(): pass',
      driverCode: 'print(f())',
      testsKey: 'questions/q1/v1/tests.json',
      ...limits,
    });
    expect(parsed.type).toBe('ANSWER');
  });

  it('accepts a SETUP message', () => {
    const parsed = executeMsg.parse({
      type: 'SETUP',
      questionId: 'q1',
      version: 1,
      attempt: 1,
      referenceKey: 'questions/q1/v1/reference.py',
      generatorKey: 'questions/q1/v1/generator.py',
      testsKey: 'questions/q1/v1/tests.json',
      smallInputs: ['1', '2'],
      largeInputCount: 3,
      ...limits,
    });
    expect(parsed.type).toBe('SETUP');
  });

  it.each([
    ['an unsupported language', { language: 'rust' }],
    ['an unknown type', { type: 'OTHER' }],
    ['a missing driver', { driverCode: undefined }],
  ])('rejects an ANSWER message with %s', (_label, change) => {
    const base = {
      type: 'ANSWER',
      ...answerRef,
      questionId: 'q1',
      version: 1,
      language: 'python',
      correctedCode: 'code',
      driverCode: 'driver',
      testsKey: 'k',
      ...limits,
    };
    expect(executeMsg.safeParse({ ...base, ...change }).success).toBe(false);
  });
});

describe('resultMsg', () => {
  it('accepts a completed ANSWER result', () => {
    expect(
      resultMsg.safeParse({
        type: 'ANSWER',
        ...answerRef,
        outcome: 'COMPLETED',
        verdicts: [
          { index: 0, kind: 'small', verdict: 'WA', input: '1', expected: '2', actual: '3' },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a failed ANSWER result with a reason', () => {
    expect(
      resultMsg.safeParse({
        type: 'ANSWER',
        ...answerRef,
        outcome: 'FAILED',
        failReason: 'DRIVER_MISMATCH',
      }).success,
    ).toBe(true);
  });

  it('rejects a failed ANSWER result without a reason', () => {
    expect(resultMsg.safeParse({ type: 'ANSWER', ...answerRef, outcome: 'FAILED' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown verdict', () => {
    expect(
      resultMsg.safeParse({
        type: 'ANSWER',
        ...answerRef,
        outcome: 'COMPLETED',
        verdicts: [{ index: 0, kind: 'small', verdict: 'OK' }],
      }).success,
    ).toBe(false);
  });

  it('accepts both SETUP outcomes', () => {
    const base = { type: 'SETUP', questionId: 'q1', version: 1, attempt: 1 };
    expect(
      resultMsg.safeParse({ ...base, outcome: 'OK', testsKey: 'k', testCount: 10 }).success,
    ).toBe(true);
    expect(
      resultMsg.safeParse({
        ...base,
        outcome: 'REFERENCE_FAILED',
        failedInputIndexes: [3, 8],
        reason: 'timeout',
      }).success,
    ).toBe(true);
  });
});
