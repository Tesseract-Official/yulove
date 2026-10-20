import type { AppealReason, Verdict } from './enums.js';
import { isTeacherOverride } from './visibility.js';
import { TEST_COUNTS } from './questions.js';
import { computeQuestionScore } from './scoring.js';
import type { AnswerItem, AppealItem } from './types.js';
import { VERDICT_TEXT_LIMIT } from './verdicts.js';

/**
 * What a student may see about one question, and nothing more. This is the only place that
 * decides it: no transcription, code, fixes, failure reasons, override details, image, or test
 * data beyond the failed small tests and the verdict of each failed large test. The photo is not
 * here either: the page fetches its own photo through a route that checks ownership, and `hasPhoto`
 * only says whether there is one.
 */
export interface StudentAppealView {
  appealId: string;
  status: AppealItem['status'];
  /** Absent on appeals made before reasons existed. */
  reason?: AppealReason;
  message: string;
  /** The reviewer's note, once there is one. */
  note?: string;
  createdAt: string;
}

export interface FailedSmallTest {
  index: number;
  verdict: Verdict;
  input?: string;
  expected?: string;
  actual?: string;
}

export interface FailedLargeTest {
  /** "Large test 2" */
  label: string;
  verdict: Verdict;
  /** "Large test 2: time limit exceeded" */
  message: string;
}

export type StudentQuestionStatus =
  'GRADED' | 'FAILED_TO_GRADE' | 'IN_PROGRESS' | 'NOT_SUBMITTED' | 'ABSENT';

export interface StudentQuestionView {
  number: number;
  marks: number;
  score: number;
  status: StudentQuestionStatus;
  /** Lines to show next to the question, in order. */
  messages: string[];
  testsPassed?: number;
  testsTotal?: number;
  failedSmallTests: FailedSmallTest[];
  failedLargeTests: FailedLargeTest[];
  /** A teacher set the score by hand. A super admin's override is not shown to students. */
  adjusted: boolean;
  /** Who: shown as a word only, never a name or email. */
  adjustedBy?: 'teacher';
  /** The student has a graded photo of this answer to look at. */
  hasPhoto: boolean;
  appeal?: StudentAppealView;
  /** Whether the student may raise an appeal on this question now. */
  canAppeal: boolean;
}

export const MESSAGES = {
  absent: 'Absent',
  adjustedByTeacher: 'Score adjusted by teacher',
  notGraded: 'Could not be graded — raise an appeal',
  inProgress: 'Still being graded',
  notSubmitted: 'No answer was submitted',
  complexity: (target: string) => `Did not meet the required time complexity, ${target}`,
} as const;

const VERDICT_WORDS: Record<Verdict, string> = {
  AC: 'accepted',
  WA: 'wrong answer',
  TLE: 'time limit exceeded',
  MLE: 'memory limit exceeded',
  RE: 'runtime error',
  CE: 'compile error',
};

const cut = (text: string) =>
  text.length > VERDICT_TEXT_LIMIT ? `${text.slice(0, VERDICT_TEXT_LIMIT - 3)}...` : text;

/** The student's view of an appeal: status and the reviewer's note, not who handled it. */
export function appealView(appeal: AppealItem): StudentAppealView {
  return {
    appealId: appeal.appealId,
    status: appeal.status,
    ...(appeal.reason ? { reason: appeal.reason } : {}),
    message: appeal.message,
    ...(appeal.note ? { note: appeal.note } : {}),
    createdAt: appeal.createdAt,
  };
}

/** The newest of a student's appeals on a question. */
export function latestAppeal(appeals: readonly AppealItem[]): AppealItem | undefined {
  return [...appeals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function studentQuestionView(input: {
  number: number;
  marks: number;
  answer: AnswerItem | undefined;
  absent: boolean;
  /** The question's required time complexity, e.g. "O(n)". */
  targetComplexity?: string;
  /** The student's latest appeal on this question. */
  appeal?: AppealItem;
}): StudentQuestionView {
  const { number, marks, answer, absent, appeal } = input;
  const view: StudentQuestionView = {
    number,
    marks,
    score: computeQuestionScore(marks, answer, absent),
    status: 'GRADED',
    messages: [],
    failedSmallTests: [],
    failedLargeTests: [],
    adjusted: false,
    hasPhoto: false,
    canAppeal: false,
  };
  if (appeal) view.appeal = appealView(appeal);

  if (absent) return { ...view, status: 'ABSENT', messages: [MESSAGES.absent] };
  if (!answer) return { ...view, status: 'NOT_SUBMITTED', messages: [MESSAGES.notSubmitted] };

  const noOpenAppeal = appeal?.status !== 'OPEN';
  view.hasPhoto = answer.imageKey !== undefined;
  // A super admin's override (or one from before teachers could override) is applied to the score
  // but never shown: the student just sees the score.
  if (isTeacherOverride(answer.override)) {
    view.adjusted = true;
    view.adjustedBy = 'teacher';
    view.messages.push(MESSAGES.adjustedByTeacher);
  }

  if (answer.status === 'FAILED_TO_GRADE') {
    return {
      ...view,
      status: 'FAILED_TO_GRADE',
      messages: [MESSAGES.notGraded, ...view.messages],
      canAppeal: noOpenAppeal,
    };
  }
  if (answer.status !== 'GRADED') {
    return { ...view, status: 'IN_PROGRESS', messages: [MESSAGES.inProgress, ...view.messages] };
  }

  view.canAppeal = noOpenAppeal;
  if (answer.testsPassed !== undefined) view.testsPassed = answer.testsPassed;
  if (answer.testsTotal !== undefined) view.testsTotal = answer.testsTotal;

  if (answer.meetsComplexity === false && input.targetComplexity) {
    view.messages.unshift(MESSAGES.complexity(input.targetComplexity));
  }

  for (const v of answer.verdicts ?? []) {
    if (v.verdict === 'AC') continue;
    if (v.kind === 'small') {
      view.failedSmallTests.push({
        index: v.index,
        verdict: v.verdict,
        ...(v.input !== undefined ? { input: cut(v.input) } : {}),
        ...(v.expected !== undefined ? { expected: cut(v.expected) } : {}),
        ...(v.actual !== undefined ? { actual: cut(v.actual) } : {}),
      });
    } else {
      const label = `Large test ${v.index - TEST_COUNTS.small + 1}`;
      view.failedLargeTests.push({
        label,
        verdict: v.verdict,
        message: `${label}: ${VERDICT_WORDS[v.verdict]}`,
      });
    }
  }
  return view;
}
