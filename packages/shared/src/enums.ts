export const ROLES = ['SUPER_ADMIN', 'TEACHER', 'BATCH_MANAGER', 'STUDENT'] as const;
export type Role = (typeof ROLES)[number];

export const ANSWER_STATUSES = [
  'QUEUED',
  'TRANSCRIBING',
  'RUNNING',
  'GRADED',
  'FAILED_TO_GRADE',
] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export const QUESTION_TEST_STATUSES = [
  'GENERATING',
  'NEEDS_REVIEW',
  'APPROVED',
  'GENERATION_FAILED',
] as const;
export type QuestionTestStatus = (typeof QUESTION_TEST_STATUSES)[number];

export const EXAM_STATUSES = ['DRAFT', 'READY', 'PUBLISHED'] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

export const APPEAL_STATUSES = ['OPEN', 'RERUN', 'CLOSED'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/** Why a student appeals: chosen on the appeal form. */
export const APPEAL_REASONS = ['PHOTO_UNCLEAR', 'CODE_READ_WRONG', 'WRONG_MARKS', 'OTHER'] as const;
export type AppealReason = (typeof APPEAL_REASONS)[number];

export const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const LANGUAGES = ['python', 'cpp', 'java', 'go'] as const;
export type Language = (typeof LANGUAGES)[number];

/** exact (after trimming trailing whitespace), any order, or float within 1e-6. */
export const COMPARE_MODES = ['EXACT', 'ANY_ORDER', 'FLOAT'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

/** Reasons an answer ends as FAILED_TO_GRADE. */
export const FAIL_REASONS = [
  'UNREADABLE',
  'UNSUPPORTED_LANGUAGE',
  'GEMINI_ERROR',
  'WORKER_ERROR',
  'DRIVER_MISMATCH',
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

/** Roles a super admin can create through POST /staff. */
export const STAFF_ROLES = ['TEACHER', 'BATCH_MANAGER'] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];
