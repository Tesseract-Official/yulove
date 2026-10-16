import { describe, expect, it } from 'vitest';
import { ConflictError } from './errors.js';
import {
  assertOverrideAllowed,
  computeExamTotal,
  computeQuestionScore,
  computeRawScore,
  roundScore,
  type ScorableAnswer,
} from './scoring.js';

const graded = (testsPassed: number, overrides: Partial<ScorableAnswer> = {}): ScorableAnswer => ({
  status: 'GRADED',
  testsPassed,
  testsTotal: 10,
  meetsComplexity: true,
  ...overrides,
});

interface Case {
  name: string;
  marks: number;
  answer: ScorableAnswer | undefined;
  absent: boolean;
  expected: number;
}

const CASES: Case[] = [
  { name: '0/10 tests', marks: 10, answer: graded(0), absent: false, expected: 0 },
  { name: '10/10 tests', marks: 10, answer: graded(10), absent: false, expected: 10 },
  { name: '7/10 tests on 10 marks', marks: 10, answer: graded(7), absent: false, expected: 7 },
  { name: '7/10 tests on 5 marks', marks: 5, answer: graded(7), absent: false, expected: 3.5 },
  {
    name: 'complexity target missed, all tests pass',
    marks: 10,
    answer: graded(10, { meetsComplexity: false }),
    absent: false,
    expected: 0,
  },
  {
    name: 'complexity unknown',
    marks: 10,
    answer: graded(10, { meetsComplexity: undefined }),
    absent: false,
    expected: 0,
  },
  {
    name: 'FAILED_TO_GRADE',
    marks: 10,
    answer: { status: 'FAILED_TO_GRADE' },
    absent: false,
    expected: 0,
  },
  {
    name: 'FAILED_TO_GRADE even with stale test counts',
    marks: 10,
    answer: graded(10, { status: 'FAILED_TO_GRADE' }),
    absent: false,
    expected: 0,
  },
  {
    name: 'still running',
    marks: 10,
    answer: graded(10, { status: 'RUNNING' }),
    absent: false,
    expected: 0,
  },
  { name: 'no answer uploaded', marks: 10, answer: undefined, absent: false, expected: 0 },
  {
    name: 'no tests recorded',
    marks: 10,
    answer: graded(0, { testsTotal: 0 }),
    absent: false,
    expected: 0,
  },
  {
    name: 'absent student with a perfect answer',
    marks: 10,
    answer: graded(10),
    absent: true,
    expected: 0,
  },
  {
    name: 'override replaces a lower formula score',
    marks: 10,
    answer: graded(3, { override: { score: 9 } }),
    absent: false,
    expected: 9,
  },
  {
    name: 'override replaces a higher formula score',
    marks: 10,
    answer: graded(10, { override: { score: 2 } }),
    absent: false,
    expected: 2,
  },
  {
    name: 'override of zero is still an override',
    marks: 10,
    answer: graded(10, { override: { score: 0 } }),
    absent: false,
    expected: 0,
  },
  {
    name: 'override applies to a failed-to-grade answer',
    marks: 10,
    answer: graded(0, { status: 'FAILED_TO_GRADE', override: { score: 6 } }),
    absent: false,
    expected: 6,
  },
  {
    name: 'override on an absent student is ignored',
    marks: 10,
    answer: graded(10, { override: { score: 8 } }),
    absent: true,
    expected: 0,
  },
];

describe('computeQuestionScore', () => {
  it.each(CASES)('$name', ({ marks, answer, absent, expected }) => {
    expect(computeQuestionScore(marks, answer, absent)).toBeCloseTo(expected, 10);
  });
});

describe('computeRawScore: rounding to 2 decimal places', () => {
  // [passed, total, marks, expected]. toBe, not toBeCloseTo: the result must be exact.
  it.each([
    [7, 10, 3, 2.1],
    [1, 3, 1, 0.33],
    [2, 3, 1, 0.67],
    [1, 3, 10, 3.33],
    [7, 10, 5, 3.5],
    [1, 8, 1, 0.13],
    [0, 10, 3, 0],
    [10, 10, 3, 3],
    [1, 200, 1, 0.01],
    [1, 400, 1, 0],
  ])('%i/%i of %i marks = %f', (passed, total, marks, expected) => {
    expect(computeRawScore(marks, graded(passed, { testsTotal: total }))).toBe(expected);
  });

  it('rounds the override too', () => {
    expect(computeQuestionScore(10, graded(0, { override: { score: 6.666 } }), false)).toBe(6.67);
  });
});

describe('roundScore', () => {
  it.each([
    [2.0999999999999996, 2.1],
    [1.005, 1.01],
    [0.125, 0.13],
    [0.3333333, 0.33],
    [5, 5],
  ])('%f -> %f', (value, expected) => {
    expect(roundScore(value)).toBe(expected);
  });
});

describe('computeRawScore', () => {
  it('ignores an override', () => {
    expect(computeRawScore(10, graded(7, { override: { score: 1 } }))).toBe(7);
  });

  it('never exceeds the marks even with bad counts', () => {
    expect(computeRawScore(10, graded(15))).toBe(10);
    expect(computeRawScore(10, graded(-2))).toBe(0);
  });
});

describe('computeExamTotal', () => {
  const questions = [
    { number: 1, marks: 10 },
    { number: 2, marks: 5 },
    { number: 3, marks: 5 },
  ];

  it('sums displayed scores and the maximum', () => {
    const answers = new Map<number, ScorableAnswer>([
      [1, graded(7)],
      [2, graded(10)],
      [3, graded(10, { meetsComplexity: false })],
    ]);
    expect(computeExamTotal(questions, answers, false)).toEqual({ totalScore: 12, maxScore: 20 });
  });

  it('counts questions without an answer as zero', () => {
    expect(computeExamTotal(questions, new Map([[1, graded(10)]]), false)).toEqual({
      totalScore: 10,
      maxScore: 20,
    });
  });

  it('applies overrides and failed-to-grade per question', () => {
    const answers: Record<number, ScorableAnswer> = {
      1: graded(0, { override: { score: 8 } }),
      2: graded(10, { status: 'FAILED_TO_GRADE' }),
      3: graded(5),
    };
    expect(computeExamTotal(questions, answers, false)).toEqual({ totalScore: 10.5, maxScore: 20 });
  });

  it('totals the rounded question scores, not the exact ones', () => {
    // 1/3 of 1 mark is 0.33 each; three of them make 0.99, not 1.
    const thirds = [1, 2, 3].map((number) => ({ number, marks: 1 }));
    const answers = new Map<number, ScorableAnswer>(
      thirds.map(({ number }) => [number, graded(1, { testsTotal: 3 })]),
    );
    expect(computeExamTotal(thirds, answers, false)).toEqual({ totalScore: 0.99, maxScore: 3 });
  });

  it('does not leave floating point noise in the total', () => {
    const qs = [
      { number: 1, marks: 3 },
      { number: 2, marks: 3 },
    ];
    const answers = new Map<number, ScorableAnswer>([
      [1, graded(7)],
      [2, graded(1)],
    ]);
    // 2.1 + 0.3 = 2.4000000000000004 in floating point.
    expect(computeExamTotal(qs, answers, false).totalScore).toBe(2.4);
  });

  it('is zero for an absent student but keeps the maximum', () => {
    const answers = new Map<number, ScorableAnswer>([[1, graded(10, { override: { score: 10 } })]]);
    expect(computeExamTotal(questions, answers, true)).toEqual({ totalScore: 0, maxScore: 20 });
  });
});

describe('assertOverrideAllowed', () => {
  it('allows an override on a present student', () => {
    expect(() => assertOverrideAllowed({ absent: false })).not.toThrow();
  });

  it('allows an override when there is no exam-student row yet', () => {
    expect(() => assertOverrideAllowed(undefined)).not.toThrow();
  });

  it('rejects an override on an absent student with a 409', () => {
    try {
      assertOverrideAllowed({ absent: true });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).statusCode).toBe(409);
      expect((error as ConflictError).message).toBe(
        'Student is marked absent; unmark absent first',
      );
    }
  });
});
