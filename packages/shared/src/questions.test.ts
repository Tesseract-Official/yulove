import { describe, expect, it } from 'vitest';
import {
  questionKeys,
  TEST_COUNTS,
  testKind,
  testsFileSchema,
  testsStillValid,
  type QuestionContent,
} from './questions.js';

describe('TEST_COUNTS', () => {
  it('is 7 small + 3 large = 10', () => {
    expect(TEST_COUNTS).toEqual({ small: 7, large: 3, total: 10 });
  });

  it.each([
    [0, 'small'],
    [6, 'small'],
    [7, 'large'],
    [9, 'large'],
  ])('test %i is %s', (index, kind) => {
    expect(testKind(index)).toBe(kind);
  });
});

describe('questionKeys', () => {
  it('puts everything under questions/{id}/v{n}/', () => {
    expect(questionKeys('q-1', 3)).toEqual({
      prefix: 'questions/q-1/v3/',
      reference: 'questions/q-1/v3/reference.py',
      generator: 'questions/q-1/v3/generator.py',
      smallInputs: 'questions/q-1/v3/small-inputs.json',
      tests: 'questions/q-1/v3/tests.json',
    });
  });
});

describe('testsFileSchema', () => {
  const tests = (n: number) =>
    Array.from({ length: n }, (_, index) => ({
      index,
      kind: index < 7 ? ('small' as const) : ('large' as const),
      input: '{}',
      expected: '1',
    }));

  it('accepts exactly 10 tests', () => {
    expect(
      testsFileSchema.safeParse({ questionId: 'q', version: 1, tests: tests(10) }).success,
    ).toBe(true);
  });

  it.each([9, 11, 0])('rejects %i tests', (n) => {
    expect(
      testsFileSchema.safeParse({ questionId: 'q', version: 1, tests: tests(n) }).success,
    ).toBe(false);
  });
});

describe('testsStillValid', () => {
  const base: QuestionContent = {
    title: 'T',
    statement: 'S',
    ioDescription: 'IO',
    constraints: 'C',
    examples: [{ input: '1', output: '2' }],
    targetComplexity: 'O(n)',
    timeLimitMs: 1000,
    memoryMb: 256,
    compareMode: 'EXACT',
  };

  it('is true when only the title or examples change', () => {
    expect(testsStillValid(base, { ...base, title: 'New title' })).toBe(true);
    expect(testsStillValid(base, { ...base, examples: [{ input: '9', output: '9' }] })).toBe(true);
  });

  it.each([
    ['statement', { statement: 'other' }],
    ['ioDescription', { ioDescription: 'other' }],
    ['constraints', { constraints: 'other' }],
    ['targetComplexity', { targetComplexity: 'O(n log n)' }],
    ['timeLimitMs', { timeLimitMs: 2000 }],
    ['memoryMb', { memoryMb: 512 }],
    ['compareMode', { compareMode: 'ANY_ORDER' as const }],
  ])('is false when %s changes', (_field, change) => {
    expect(testsStillValid(base, { ...base, ...change })).toBe(false);
  });
});
