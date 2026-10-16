import type { AnswerStatus } from './enums.js';
import { ConflictError } from './errors.js';
import type { ExamQuestionRef, Override } from './types.js';

/** The answer fields scoring looks at. */
export interface ScorableAnswer {
  status: AnswerStatus;
  testsPassed?: number;
  testsTotal?: number;
  meetsComplexity?: boolean;
  override?: Pick<Override, 'score'>;
}

/** Rounds to 2 decimal places (half up), tolerating binary floating point noise. */
export function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * The formula: (testsPassed / testsTotal) x marks, rounded to 2 decimal places. Zero when the
 * answer was not graded (including FAILED_TO_GRADE), when it misses the complexity target, or
 * when there are no tests to count. This is what the Record stage stores as `score`.
 */
export function computeRawScore(marks: number, answer: ScorableAnswer | undefined): number {
  if (!answer || answer.status !== 'GRADED') return 0;
  if (answer.meetsComplexity !== true) return 0;

  const { testsPassed, testsTotal } = answer;
  if (testsPassed === undefined || testsTotal === undefined || testsTotal <= 0) return 0;

  const passed = Math.min(Math.max(testsPassed, 0), testsTotal);
  // Multiply before dividing so 7/10 of 3 marks is 21/10, not 0.7 x 3.
  return roundScore((passed * marks) / testsTotal);
}

/**
 * The displayed score. Absent students score 0 (an override on them is ignored). Otherwise an
 * override replaces the formula score.
 */
export function computeQuestionScore(
  marks: number,
  answer: ScorableAnswer | undefined,
  absent: boolean,
): number {
  if (absent) return 0;
  if (answer?.override) return roundScore(answer.override.score);
  return computeRawScore(marks, answer);
}

export interface ExamTotal {
  totalScore: number;
  maxScore: number;
}

/**
 * Sum of the rounded, displayed question scores. Questions with no answer count as 0.
 * `answers` is keyed by question number.
 */
export function computeExamTotal(
  questions: Pick<ExamQuestionRef, 'number' | 'marks'>[],
  answers: ReadonlyMap<number, ScorableAnswer> | Readonly<Record<number, ScorableAnswer>>,
  absent: boolean,
): ExamTotal {
  const lookup = (n: number): ScorableAnswer | undefined =>
    answers instanceof Map ? answers.get(n) : (answers as Record<number, ScorableAnswer>)[n];

  let totalScore = 0;
  let maxScore = 0;
  for (const q of questions) {
    maxScore += q.marks;
    totalScore += computeQuestionScore(q.marks, lookup(q.number), absent);
  }
  return { totalScore: roundScore(totalScore), maxScore: roundScore(maxScore) };
}

/**
 * The override endpoint calls this before setting an override. Absent wins over an override, so
 * an override on an absent student would have no effect; reject it instead.
 */
export function assertOverrideAllowed(student: { absent: boolean } | undefined): void {
  if (student?.absent) {
    throw new ConflictError('Student is marked absent; unmark absent first');
  }
}
