import type {
  AnswerStatus,
  CompareMode,
  ExamStatus,
  FailReason,
  Language,
  QuestionTestStatus,
  Role,
  StaffRole,
} from './enums.js';
import type { StudentQuestionView } from './student-view.js';
import type { AppealItem, Example, ExamItem, Override, Signature, TestVerdict } from './types.js';

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
  /** Email of the teacher who made the exam. */
  createdBy: string;
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

/** One question in GET /questions: its latest version. */
export interface QuestionSummary {
  questionId: string;
  version: number;
  title: string;
  targetComplexity: string;
  teacherEmail: string;
  testStatus?: QuestionTestStatus | undefined;
  testFailure?: string | undefined;
  /** How many exams use this version. */
  usedInExams: number;
}

/** GET /questions */
export interface QuestionListResponse {
  questions: QuestionSummary[];
}

/** A question as the teacher screens see it: what they wrote, and the state of its tests. */
export interface QuestionDetail {
  questionId: string;
  version: number;
  teacherEmail: string;
  title: string;
  statement: string;
  ioDescription: string;
  constraints: string;
  examples: Example[];
  targetComplexity: string;
  timeLimitMs: number;
  memoryMb: number;
  compareMode: CompareMode;
  signature?: Signature | undefined;
  testStatus?: QuestionTestStatus | undefined;
  testCount?: number | undefined;
  testFailure?: string | undefined;
}

/** GET /questions/{id} */
export interface QuestionDetailResponse {
  question: QuestionDetail;
  /** An exam using this version has answers: an edit makes a new version. */
  inUse: boolean;
  /** How many exams use this version. */
  usedInExams: number;
}

/** POST /questions (201) */
export interface CreateQuestionResponse {
  question: QuestionDetail;
}

/** PUT /questions/{id}: 200 when edited in place, 201 when it made a new version. */
export interface SaveQuestionResponse {
  question: QuestionDetail | undefined;
  newVersion: boolean;
  /** The generated tests still apply (only the title or examples changed). */
  testsKept: boolean;
}

/** POST /questions/{id}/generate-tests (202) */
export interface GenerateTestsResponse {
  questionId: string;
  version: number;
  testStatus: 'GENERATING';
  attempt: number;
}

/** POST /questions/{id}/approve */
export interface ApproveQuestionResponse {
  questionId: string;
  version: number;
  testStatus: 'APPROVED';
}

/** One test in the review: input and expected output, each cut to a preview. */
export interface TestPreview {
  index: number;
  kind: 'small' | 'large';
  input: string;
  expected: string;
  /** The input or output was cut because it is very long. */
  truncated: boolean;
}

/** GET /questions/{id}/tests */
export interface QuestionTestsResponse {
  questionId: string;
  version: number;
  testStatus: QuestionTestStatus | null;
  signature: Signature | null;
  testFailure?: string;
  /** Present once the tests are ready for review or approved. */
  tests?: TestPreview[];
}

/** One question of an exam in GET /exams/{id}. */
export interface ExamDetailQuestion {
  number: number;
  questionId: string;
  version: number;
  marks: number;
  /** Undefined when that question version no longer exists. */
  title: string | undefined;
  testStatus: QuestionTestStatus | undefined;
  exists: boolean;
}

/** GET /exams/{id} */
export interface ExamDetailResponse {
  exam: {
    examId: string;
    batchId: string;
    title: string;
    date: string;
    status: ExamStatus;
    createdBy: string;
    publishedAt: string | undefined;
    questions: ExamDetailQuestion[];
  };
  /** Any answer exists: the questions and marks are locked. */
  hasAnswers: boolean;
  hasPdf: boolean;
  /** The caller made the exam (or is a super admin) and it is not published. */
  canEdit: boolean;
}

/** POST /exams (201) and PUT /exams/{id} */
export interface SaveExamResponse {
  exam: ExamItem;
  /** PUT only: false when nothing was different. */
  changed?: boolean;
  /** POST only: how many student rows were written now, and how many are left for first access. */
  studentRows?: { created: number; pending: number };
}

/** POST /exams/{id}/pdf */
export interface ExamPdfResponse {
  examId: string;
  status: ExamStatus;
  pdfKey: string;
  pageCount: number;
}

/** GET /exams/{id}/pdf: a link that works for `expiresInSeconds`. */
export interface ExamPdfLinkResponse {
  url: string;
  expiresInSeconds: number;
  filename: string;
}

/** One question of one student in GET /exams/{id}/results. */
export interface ResultCell extends QuestionCell {
  failedToGrade: boolean;
}

/** One student's row in GET /exams/{id}/results. */
export interface ResultStudentRow extends Omit<BoardStudentRow, 'questions'> {
  questions: ResultCell[];
  /** How many of the student's questions could not be graded. */
  failedToGrade: number;
}

/** GET /exams/{id}/results */
export interface ExamResultsResponse {
  examId: string;
  title: string;
  date: string;
  examStatus: ExamStatus;
  maxScore: number;
  questions: Array<{ number: number; marks: number }>;
  students: ResultStudentRow[];
}

/** One published exam in GET /me/exams. */
export interface MyExamSummary {
  examId: string;
  title: string;
  date: string;
  absent: boolean;
  totalScore: number;
  maxScore: number;
}

/** GET /me/exams */
export interface MyExamsResponse {
  exams: MyExamSummary[];
}

/** GET /me/exams/{id}: the student's own result for one published exam. */
export interface MyExamResultResponse {
  examId: string;
  title: string;
  date: string;
  absent: boolean;
  /** "Absent", when the student was marked absent. */
  message?: string;
  totalScore: number;
  maxScore: number;
  questions: StudentQuestionView[];
}

/** One appeal in the review queue, with the student's name and roll number. */
export interface AppealSummary extends AppealItem {
  studentName: string | undefined;
  rollNo: string | undefined;
}

/** GET /appeals?examId=&status= */
export interface AppealListResponse {
  examId: string;
  appeals: AppealSummary[];
}

/** POST /appeals (201) */
export interface CreateAppealResponse {
  appeal: AppealItem;
}

/** PUT /appeals/{id}: `attempt` is set when the answer was sent to be graded again. */
export interface UpdateAppealResponse {
  appeal: AppealItem;
  attempt?: number;
}

/** PUT /answers/{examId}/{studentEmail}/{q}/override */
export interface SetOverrideResponse {
  examId: string;
  studentEmail: string;
  questionNumber: number;
  /** The score now shown for the question. */
  score: number;
  override: Override | null;
  totalScore: number;
  maxScore: number;
}

/** One recorded change to an answer's score. */
export interface AuditEntry {
  timestamp: string;
  actor: string;
  /** OVERRIDE_SCORE or CLEAR_OVERRIDE. */
  action: string;
  /** `{ override, displayedScore }` before the change. */
  before: unknown;
  after: unknown;
  reason: string;
}

/** GET /answers/{examId}/{studentEmail}/{q}/audit, newest first. */
export interface AuditHistoryResponse {
  examId: string;
  studentEmail: string;
  questionNumber: number;
  entries: AuditEntry[];
}
