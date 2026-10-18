import { z } from 'zod';
import { COMPARE_MODES, STAFF_ROLES } from './enums.js';

const email = z.string().trim().toLowerCase().pipe(z.email());
const id = z.string().trim().min(1).max(128);
const positiveInt = z.number().int().positive();
const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);

/** Batch ids double as the `batch` column of the student CSV. */
const batchId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'Use letters, digits, - and _ only');

/** POST /staff */
export const createStaffBody = z.object({
  email,
  name: nonEmptyText(200),
  role: z.enum(STAFF_ROLES),
  batchIds: z.array(batchId).default([]),
});
export type CreateStaffBody = z.infer<typeof createStaffBody>;
/** What a client sends: `batchIds` may be left out. */
export type CreateStaffInput = z.input<typeof createStaffBody>;

/** PUT /staff/{email}/batches (batch managers and teachers) */
export const assignBatchesBody = z.object({
  batchIds: z.array(batchId),
});
export type AssignBatchesBody = z.infer<typeof assignBatchesBody>;

/** POST /batches */
export const createBatchBody = z.object({
  batchId,
  name: nonEmptyText(200),
});
export type CreateBatchBody = z.infer<typeof createBatchBody>;

/** PUT /answers/{examId}/{studentEmail}/{q}/override. A null score clears the override. */
export const overrideBody = z.object({
  score: z.number().min(0).nullable(),
  reason: nonEmptyText(1000),
});
export type OverrideBody = z.infer<typeof overrideBody>;

/** PUT /users/{email}/active: switch a person off or on again. A reason is always required. */
export const setActiveBody = z.object({
  active: z.boolean(),
  reason: nonEmptyText(1000),
});
export type SetActiveBody = z.infer<typeof setActiveBody>;

/** POST /batches/{batchId}/students/import. Raw CSV text: name, email, roll number, batch. */
export const importStudentsBody = z.object({
  csv: z.string().min(1).max(1_000_000),
});
export type ImportStudentsBody = z.infer<typeof importStudentsBody>;

const answerRef = {
  examId: id,
  studentEmail: email,
  questionNumber: positiveInt,
};

/** POST /answers/upload-url. The app compresses every crop to JPEG. */
export const requestUploadUrlBody = z.object({
  ...answerRef,
  contentType: z.literal('image/jpeg'),
});
export type RequestUploadUrlBody = z.infer<typeof requestUploadUrlBody>;

/** POST /answers/submit */
export const submitAnswerBody = z.object(answerRef);
export type SubmitAnswerBody = z.infer<typeof submitAnswerBody>;

/** PUT /exams/{examId}/students/{email}/absent */
export const setAbsentBody = z.object({
  absent: z.boolean(),
});
export type SetAbsentBody = z.infer<typeof setAbsentBody>;

/** POST /exams/{id}/publish. `confirm` publishes even though some answers are still being graded. */
export const publishBody = z.object({
  confirm: z.boolean().optional(),
});
export type PublishBody = z.infer<typeof publishBody>;

const exampleSchema = z.object({
  input: z.string().min(1),
  output: z.string(),
  explanation: z.string().optional(),
});

/** POST /questions and PUT /questions/{id} */
export const questionBody = z.object({
  title: nonEmptyText(200),
  statement: nonEmptyText(20_000),
  ioDescription: nonEmptyText(5_000),
  constraints: nonEmptyText(5_000),
  examples: z.array(exampleSchema).min(1).max(3),
  targetComplexity: nonEmptyText(100),
  timeLimitMs: positiveInt,
  memoryMb: positiveInt,
  compareMode: z.enum(COMPARE_MODES),
});
export type QuestionBody = z.infer<typeof questionBody>;

const examQuestionSchema = z.object({
  number: positiveInt,
  questionId: id,
  version: positiveInt,
  marks: z.number().positive(),
});

/** Most questions an exam can have. */
export const MAX_EXAM_QUESTIONS = 50;

/** POST /exams and PUT /exams/{id}. Question numbers must be 1, 2, 3... n, in order. */
export const examBody = z.object({
  batchId,
  title: nonEmptyText(200),
  date: z.iso.date(),
  questions: z
    .array(examQuestionSchema)
    .min(1)
    .max(MAX_EXAM_QUESTIONS)
    .refine((qs) => qs.every((q, i) => q.number === i + 1), {
      message: 'Question numbers must be 1 to n, in order',
    }),
});
export type ExamBody = z.infer<typeof examBody>;

/** PUT /appeals/{id}: close an appeal with a note. */
export const closeAppealBody = z.object({
  status: z.literal('CLOSED'),
  note: nonEmptyText(2_000),
});
export type CloseAppealBody = z.infer<typeof closeAppealBody>;

/** PUT /appeals/{id}: send the answer to be graded again, with an optional note. */
export const rerunAppealBody = z.object({
  status: z.literal('RERUN'),
  note: nonEmptyText(2_000).optional(),
});
export type RerunAppealBody = z.infer<typeof rerunAppealBody>;

/** PUT /appeals/{id}: close with a note, or have the answer graded again. */
export const updateAppealBody = z.discriminatedUnion('status', [closeAppealBody, rerunAppealBody]);
export type UpdateAppealBody = z.infer<typeof updateAppealBody>;

/** Longest message a student may write in an appeal. */
export const APPEAL_MESSAGE_MAX = 1_000;

/** POST /appeals. The student comes from the JWT, not the body. */
export const createAppealBody = z.object({
  examId: id,
  questionNumber: positiveInt,
  message: nonEmptyText(APPEAL_MESSAGE_MAX),
});
export type CreateAppealBody = z.infer<typeof createAppealBody>;
