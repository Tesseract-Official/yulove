import type {
  AnswerDetailResponse,
  ApproveQuestionResponse,
  AssignBatchesResponse,
  BatchListResponse,
  CreateBatchBody,
  CreateBatchResponse,
  CreateQuestionResponse,
  CreateStaffInput,
  CreateStaffResponse,
  ExamBoardResponse,
  ExamBody,
  ExamDetailResponse,
  ExamListResponse,
  ExamPdfLinkResponse,
  ExamPdfResponse,
  ExamResultsResponse,
  GenerateTestsResponse,
  ImportStudentsResponse,
  MeResponse,
  PublishResponse,
  QuestionBody,
  QuestionDetailResponse,
  QuestionListResponse,
  QuestionTestsResponse,
  RequestUploadUrlBody,
  SaveExamResponse,
  SaveQuestionResponse,
  SetAbsentResponse,
  StaffListResponse,
  SubmitAnswerBody,
  SubmitAnswerResponse,
  UploadUrlResponse,
} from '@yulove/shared';
import type { ApiClient } from './client.js';

const enc = encodeURIComponent;

/**
 * One typed function per API route, using the request and response types from @yulove/shared.
 * Screens add the routes they need here.
 */
export function createEndpoints(client: ApiClient) {
  const answerPath = (examId: string, studentEmail: string, questionNumber: number) =>
    `/answers/${enc(examId)}/${enc(studentEmail)}/${questionNumber}`;

  return {
    /** GET /me: 403 means the signed-in Google account is not registered. */
    getMe: () => client.get<MeResponse>('/me'),

    // Super admin
    listBatches: () => client.get<BatchListResponse>('/batches'),
    createBatch: (body: CreateBatchBody) => client.post<CreateBatchResponse>('/batches', body),
    listStaff: () => client.get<StaffListResponse>('/staff'),
    createStaff: (body: CreateStaffInput) => client.post<CreateStaffResponse>('/staff', body),
    assignBatches: (email: string, batchIds: string[]) =>
      client.put<AssignBatchesResponse>(`/staff/${enc(email)}/batches`, { batchIds }),

    // Batch manager
    /** Without a batch: the exams of every batch the caller works with. */
    listExams: (batchId?: string) =>
      client.get<ExamListResponse>('/exams', batchId ? { batchId } : undefined),
    importStudents: (batchId: string, csv: string) =>
      client.post<ImportStudentsResponse>(`/batches/${enc(batchId)}/students/import`, { csv }),
    getBoard: (examId: string) => client.get<ExamBoardResponse>(`/exams/${enc(examId)}/answers`),
    setAbsent: (examId: string, studentEmail: string, absent: boolean) =>
      client.put<SetAbsentResponse>(`/exams/${enc(examId)}/students/${enc(studentEmail)}/absent`, {
        absent,
      }),
    requestUploadUrl: (body: RequestUploadUrlBody) =>
      client.post<UploadUrlResponse>('/answers/upload-url', body),
    submitAnswer: (body: SubmitAnswerBody) =>
      client.post<SubmitAnswerResponse>('/answers/submit', body),
    getAnswer: (examId: string, studentEmail: string, questionNumber: number) =>
      client.get<AnswerDetailResponse>(answerPath(examId, studentEmail, questionNumber)),
    rerunAnswer: (examId: string, studentEmail: string, questionNumber: number) =>
      client.post<SubmitAnswerResponse>(
        `${answerPath(examId, studentEmail, questionNumber)}/rerun`,
      ),
    /** `confirm: true` publishes even though some answers are still being graded. */
    publishExam: (examId: string, confirm = false) =>
      client.post<PublishResponse>(`/exams/${enc(examId)}/publish`, confirm ? { confirm } : {}),

    // Teacher
    listQuestions: () => client.get<QuestionListResponse>('/questions'),
    getQuestion: (questionId: string) =>
      client.get<QuestionDetailResponse>(`/questions/${enc(questionId)}`),
    createQuestion: (body: QuestionBody) => client.post<CreateQuestionResponse>('/questions', body),
    updateQuestion: (questionId: string, body: QuestionBody) =>
      client.put<SaveQuestionResponse>(`/questions/${enc(questionId)}`, body),
    generateTests: (questionId: string) =>
      client.post<GenerateTestsResponse>(`/questions/${enc(questionId)}/generate-tests`),
    getQuestionTests: (questionId: string) =>
      client.get<QuestionTestsResponse>(`/questions/${enc(questionId)}/tests`),
    approveQuestion: (questionId: string) =>
      client.post<ApproveQuestionResponse>(`/questions/${enc(questionId)}/approve`),
    getExam: (examId: string) => client.get<ExamDetailResponse>(`/exams/${enc(examId)}`),
    createExam: (body: ExamBody) => client.post<SaveExamResponse>('/exams', body),
    updateExam: (examId: string, body: ExamBody) =>
      client.put<SaveExamResponse>(`/exams/${enc(examId)}`, body),
    generateExamPdf: (examId: string) => client.post<ExamPdfResponse>(`/exams/${enc(examId)}/pdf`),
    getExamPdfLink: (examId: string) =>
      client.get<ExamPdfLinkResponse>(`/exams/${enc(examId)}/pdf`),
    getExamResults: (examId: string) =>
      client.get<ExamResultsResponse>(`/exams/${enc(examId)}/results`),
  };
}
export type Endpoints = ReturnType<typeof createEndpoints>;
