import type {
  AppealStatus,
  CellStatus,
  CompareMode,
  ExamStatus,
  FailReason,
  QuestionTestStatus,
  Verdict,
} from '@yulove/shared';

/** What each answer status is called on screen. */
export const STATUS_LABEL: Record<CellStatus, string> = {
  NOT_SUBMITTED: 'No photo yet',
  QUEUED: 'Waiting',
  TRANSCRIBING: 'Reading the photo',
  RUNNING: 'Running the code',
  GRADED: 'Graded',
  FAILED_TO_GRADE: 'Could not be graded',
};

export type Tone = 'neutral' | 'progress' | 'good' | 'bad';

export const STATUS_TONE: Record<CellStatus, Tone> = {
  NOT_SUBMITTED: 'neutral',
  QUEUED: 'progress',
  TRANSCRIBING: 'progress',
  RUNNING: 'progress',
  GRADED: 'good',
  FAILED_TO_GRADE: 'bad',
};

/** Why an answer could not be graded, and what to do about it. */
export const FAIL_REASON_TEXT: Record<FailReason, string> = {
  UNREADABLE: 'The photo could not be read. Upload a clearer photo.',
  UNSUPPORTED_LANGUAGE: 'The code is not in Python, C++, Java or Go.',
  GEMINI_ERROR: 'The reading service had a problem. Try grading again.',
  WORKER_ERROR: 'The code runner had a problem. Try grading again.',
  DRIVER_MISMATCH:
    "The reader changed the student's code, so it was not graded. Try grading again.",
};

export const VERDICT_TEXT: Record<Verdict, string> = {
  AC: 'Passed',
  WA: 'Wrong answer',
  TLE: 'Too slow (time limit)',
  MLE: 'Used too much memory',
  RE: 'Program crashed',
  CE: 'Did not compile',
};

export const LANGUAGE_TEXT = {
  python: 'Python',
  cpp: 'C++',
  java: 'Java',
  go: 'Go',
} as const;

/** True once a photo has been uploaded for the question. */
export const hasPhoto = (status: CellStatus) => status !== 'NOT_SUBMITTED';

/** True while the answer is still on its way through grading. */
export const isGrading = (status: CellStatus) =>
  status === 'QUEUED' || status === 'TRANSCRIBING' || status === 'RUNNING';

/** "1 student", "2 students" */
export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The state of a question's tests, in plain words. */
export type TestState = QuestionTestStatus | 'NONE';

export const TEST_STATE_LABEL: Record<TestState, string> = {
  NONE: 'Not generated yet',
  GENERATING: 'Generating',
  NEEDS_REVIEW: 'Ready for review',
  APPROVED: 'Approved',
  GENERATION_FAILED: 'Failed',
};

export const TEST_STATE_TONE: Record<TestState, Tone> = {
  NONE: 'neutral',
  GENERATING: 'progress',
  NEEDS_REVIEW: 'progress',
  APPROVED: 'good',
  GENERATION_FAILED: 'bad',
};

export const EXAM_STATUS_LABEL: Record<ExamStatus, string> = {
  DRAFT: 'Draft',
  READY: 'PDF ready',
  PUBLISHED: 'Published',
};

export const EXAM_STATUS_TONE: Record<ExamStatus, Tone> = {
  DRAFT: 'neutral',
  READY: 'progress',
  PUBLISHED: 'good',
};

/** How a student's output is compared with the expected output, in plain words. */
export const COMPARE_MODE_LABEL: Record<CompareMode, string> = {
  EXACT: 'Exactly the same (spaces at the end are ignored)',
  ANY_ORDER: 'The same items in any order',
  FLOAT: 'Numbers that match to 6 decimal places',
};

/** How a failed test is put to a student: short and plain. */
export const STUDENT_VERDICT_TEXT: Record<Verdict, string> = {
  AC: 'passed',
  WA: 'wrong answer',
  TLE: 'too slow',
  MLE: 'used too much memory',
  RE: 'crashed',
  CE: 'did not compile',
};

/** An appeal, as the staff who review it see it. */
export const APPEAL_STATUS_LABEL: Record<AppealStatus, string> = {
  OPEN: 'Open',
  RERUN: 'Graded again',
  CLOSED: 'Closed',
};

export const APPEAL_STATUS_TONE: Record<AppealStatus, Tone> = {
  OPEN: 'bad',
  RERUN: 'progress',
  CLOSED: 'neutral',
};

/** An appeal, as the student who sent it sees it. */
export const STUDENT_APPEAL_TEXT: Record<AppealStatus, string> = {
  OPEN: 'Waiting for a reviewer',
  RERUN: 'Your answer was graded again',
  CLOSED: 'Closed',
};
