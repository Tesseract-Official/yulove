import type { AnswerStatus, ExamStatus, FailReason, Language, Role, StaffRole } from './enums.js';
import type { Override, TestVerdict } from './types.js';

/** Response shapes of the API, shared by the handlers and the web app. Types only. */

/** GET /batches */
export interface BatchListResponse {
  batches: Array<{ batchId: string; name: string }>;
}

/** One teacher or batch manager, as GET /staff lists them. */
export interface StaffMember {
  email: string;
  name: string;
  role: StaffRole;
  batchIds: string[];
  active: boolean;
}

/** GET /staff */
export interface StaffListResponse {
  staff: StaffMember[];
}

/** POST /staff (201) */
export interface CreateStaffResponse {
  user: { email: string; name: string; role: Role; batchIds?: string[] | undefined };
}

/** PUT /staff/{email}/batches */
export type AssignBatchesResponse = CreateStaffResponse;

/** POST /batches (201) */
export interface CreateBatchResponse {
  batch: { batchId: string; name: string };
}

/** One exam in GET /exams. */
export interface ExamSummary {
  examId: string;
  batchId: string;
  title: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  status: ExamStatus;
  questionCount: number;
}

/** GET /exams?batchId= */
export interface ExamListResponse {
  exams: ExamSummary[];
}

export interface ImportedRow {
  line: number;
  email: string;
  name: string;
  rollNo: string;
  batchId: string;
}

export interface RejectedRow {
  line: number;
  email?: string;
  rollNo?: string;
  reason: string;
}

/** POST /batches/{batchId}/students/import */
export interface ImportStudentsResponse {
  created: ImportedRow[];
  updated: ImportedRow[];
  rejected: RejectedRow[];
  counts: { rows: number; created: number; updated: number; rejected: number };
}

/** POST /answers/upload-url: a presigned S3 POST. */
export interface UploadUrlResponse {
  url: string;
  /** Form fields to send before the file, exactly as given. */
  fields: Record<string, string>;
  key: string;
  maxBytes: number;
  expiresInSeconds: number;
}

/** POST /answers/submit and POST /answers/{examId}/{studentEmail}/{q}/rerun */
export interface SubmitAnswerResponse {
  examId: string;
  studentEmail: string;
  questionNumber: number;
  attempt: number;
  status: 'QUEUED';
}

/** PUT /exams/{id}/students/{email}/absent */
export interface SetAbsentResponse {
  examId: string;
  studentEmail: string;
  absent: boolean;
  totalScore: number;
  maxScore: number;
}

/** POST /exams/{id}/publish */
export interface PublishResponse {
  examId: string;
  status: 'PUBLISHED';
  publishedBy?: string | undefined;
  publishedAt?: string | undefined;
  alreadyPublished?: boolean;
  inProgress?: number;
}

/** What is shown for a question that has no answer yet. */
export type CellStatus = AnswerStatus | 'NOT_SUBMITTED';

/** One question of one student on the status board. */
export interface QuestionCell {
  number: number;
  marks: number;
  status: CellStatus;
  /** FAILED_TO_GRADE: why. */
  failReason?: FailReason;
  failDetail?: string;
  /** What counts: the override if there is one, otherwise the formula score; 0 when absent. */
  score: number;
  overridden: boolean;
}

/** One student's row on the status board. */
export interface BoardStudentRow {
  email: string;
  name: string;
  rollNo: string | undefined;
  active: boolean;
  absent: boolean;
  questions: QuestionCell[];
  totalScore: number;
  maxScore: number;
}

/** GET /exams/{id}/answers */
export interface ExamBoardResponse {
  examId: string;
  title: string;
  examStatus: ExamStatus;
  questions: Array<{ number: number; marks: number }>;
  students: BoardStudentRow[];
  counts: Partial<Record<CellStatus, number>>;
}

/** GET /answers/{examId}/{studentEmail}/{q} */
export interface AnswerDetailResponse {
  examId: string;
  studentEmail: string;
  questionNumber: number;
  marks: number;
  absent: boolean;
  status: AnswerStatus;
  attempt: number;
  failReason: FailReason | undefined;
  failDetail: string | undefined;
  /** A link to the photo that works for `imageExpiresInSeconds`. */
  imageUrl: string | undefined;
  imageExpiresInSeconds: number | undefined;
  language: Language | undefined;
  rawTranscription: string | undefined;
  correctedCode: string | undefined;
  fixes: string[];
  estimatedComplexity: string | undefined;
  meetsComplexity: boolean | undefined;
  testsPassed: number | undefined;
  testsTotal: number | undefined;
  verdicts: TestVerdict[];
  score: number;
  override: Override | undefined;
}
