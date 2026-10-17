import type { CellStatus, FailReason, Verdict } from '@yulove/shared';

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
