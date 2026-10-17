import type {
  AnswerStatus,
  AppealStatus,
  CompareMode,
  ExamStatus,
  FailReason,
  Language,
  QuestionTestStatus,
  Role,
  Verdict,
} from './enums.js';
import { normaliseEmail } from './identity.js';

/** Users: key `email` (lower case). Indexes byBatch (batchId), byRoll (rollNo). */
export interface UserItem {
  email: string;
  role: Role;
  name: string;
  /** Students only. */
  rollNo?: string;
  /** Students only. */
  batchId?: string;
  /** Batch managers and teachers: the batches they are assigned to. */
  batchIds?: string[];
  active: boolean;
  /** Sample data written by a dev script; never real people. */
  dev?: boolean;
}

/** Batches: key `batchId`. */
export interface BatchItem {
  batchId: string;
  name: string;
  /** Sample data written by a dev script. */
  dev?: boolean;
}

export interface Example {
  input: string;
  output: string;
  explanation?: string;
}

export interface SignatureParam {
  name: string;
  type: string;
}

/** Function signature students are told to use. */
export interface Signature {
  name: string;
  parameters: SignatureParam[];
  returnType: string;
}

/** Questions: key `questionId` / `version` (number). Index byTeacher (teacherEmail). */
export interface QuestionItem {
  questionId: string;
  version: number;
  teacherEmail: string;
  title: string;
  statement: string;
  ioDescription: string;
  constraints: string;
  examples: Example[];
  signature?: Signature;
  targetComplexity: string;
  timeLimitMs: number;
  memoryMb: number;
  compareMode: CompareMode;
  /** Absent until tests have been generated for this version. */
  testStatus?: QuestionTestStatus;
  testCount?: number;
  testsKey?: string;
  /** Generation round: incremented each time tests are (re)generated or invalidated. */
  testAttempt?: number;
  /** How many times inputs have been replaced since the last full generation. */
  testRegenerations?: number;
  /** Why the last generation failed, shown to the teacher. */
  testFailure?: string;
  /** How many times this generation round ended because Gemini was busy. */
  testGenTries?: number;
  /** Sample question written by scripts/seed-dev-questions.ts; never real exam content. */
  dev?: boolean;
}

export interface ExamQuestionRef {
  number: number;
  questionId: string;
  version: number;
  marks: number;
}

/** Exams: key `examId`. Index byBatch (batchId). */
export interface ExamItem {
  examId: string;
  batchId: string;
  title: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  questions: ExamQuestionRef[];
  /** Email of the teacher who created the exam; only they (and super admins) manage it. */
  createdBy: string;
  status: ExamStatus;
  pdfKey?: string;
  publishedBy?: string;
  /** ISO timestamp. */
  publishedAt?: string;
  /** Sample data written by a dev script. */
  dev?: boolean;
}

/** ExamStudents: key `examId` / `studentEmail`. Index byStudent (studentEmail). */
export interface ExamStudentItem {
  examId: string;
  studentEmail: string;
  absent: boolean;
  totalScore?: number;
  maxScore?: number;
  /** Sample data written by a dev script. */
  dev?: boolean;
}

export interface TestVerdict {
  /** 0-based position among the question's tests. */
  index: number;
  kind: 'small' | 'large';
  verdict: Verdict;
  /** Small failed tests only, each cut to 200 characters. */
  input?: string;
  expected?: string;
  actual?: string;
}

export interface Override {
  score: number;
  reason: string;
  by: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * Answers: key `examStudent` (`${examId}#${studentEmail}`) / `questionNumber` (number).
 */
export interface AnswerItem {
  examStudent: string;
  questionNumber: number;
  imageKey?: string;
  attempt: number;
  status: AnswerStatus;
  failReason?: FailReason;
  /** A short, readable explanation for the failure (at most 300 characters). */
  failDetail?: string;
  /** How many times transcription ended because Gemini was busy; counted per attempt. */
  transcribeTries?: number;
  language?: Language;
  rawTranscription?: string;
  correctedCode?: string;
  driverCode?: string;
  fixes?: string[];
  estimatedComplexity?: string;
  meetsComplexity?: boolean;
  testsPassed?: number;
  testsTotal?: number;
  verdicts?: TestVerdict[];
  /** Formula score without any override. */
  score?: number;
  override?: Override;
  /** Sample data written by a dev script. */
  dev?: boolean;
}

/** Appeals: key `appealId`. Index byExam (examId, status). */
export interface AppealItem {
  appealId: string;
  examId: string;
  studentEmail: string;
  questionNumber: number;
  message: string;
  status: AppealStatus;
  handledBy?: string;
  note?: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** What happened to a request a super admin made. */
export type RequestOutcome = 'success' | 'denied' | 'rejected' | 'error';

/**
 * AuditLog: key `entityKey` / `timestamp` (ISO string). Index byActor (actor).
 * The last five fields are set only on the entries the API wrapper writes for super admin requests
 * (entityKey `request#<requestId>`, action = the route, e.g. `POST /exams/{id}/pdf`).
 */
export interface AuditLogItem {
  entityKey: string;
  timestamp: string;
  actor: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string;
  method?: string;
  /** The path as requested, without the query string. Never the body. */
  path?: string;
  /** Path parameters, plus the ids of anything the request created. */
  targetIds?: Record<string, string>;
  statusCode?: number;
  outcome?: RequestOutcome;
}

export function examStudentKey(examId: string, studentEmail: string): string {
  return `${examId}#${normaliseEmail(studentEmail)}`;
}
