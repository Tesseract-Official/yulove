import {
  answerImageKey,
  ConflictError,
  NotFoundError,
  parseBody,
  ValidationError,
  type ExamItem,
  type ExamQuestionRef,
  type UserItem,
  type SubmitAnswerBody,
} from '@yulove/shared';
import { examStudentsDb, examsDb, usersDb, type AuthContext } from '@yulove/shared/server';
import type { ApiEvent } from './http.js';

/** Everything the upload and submit routes know once the checks have passed. */
export interface AnswerTarget {
  exam: ExamItem;
  question: ExamQuestionRef;
  student: UserItem & { rollNo: string };
  /** `answers/{examId}/{rollNo}/q{n}.jpg` */
  imageKey: string;
}

/**
 * The checks both answer routes share, in this order:
 * - the exam exists, and the caller has its batch (403);
 * - the exam is READY or PUBLISHED (409);
 * - the question number is one of the exam's (422);
 * - the student is an active student of the exam's batch (422);
 * - the student is not marked absent (409).
 * Reads the student's ExamStudents row, creating it if the student was imported after the exam.
 */
export async function resolveAnswerTarget<T extends SubmitAnswerBody>(
  ctx: AuthContext,
  body: T,
): Promise<AnswerTarget> {
  const exam = await examsDb.getExam(body.examId);
  if (!exam) throw new NotFoundError(`No exam ${body.examId}`);
  ctx.assertBatchAccess(exam.batchId);

  if (exam.status !== 'READY' && exam.status !== 'PUBLISHED') {
    throw new ConflictError('This exam is not ready for answers yet (its status is DRAFT)');
  }
  const question = exam.questions.find((q) => q.number === body.questionNumber);
  if (!question) {
    throw new ValidationError(`The exam has no question ${body.questionNumber}`);
  }

  const student = await usersDb.getUser(body.studentEmail);
  if (
    !student ||
    student.role !== 'STUDENT' ||
    student.batchId !== exam.batchId ||
    student.active === false ||
    !student.rollNo
  ) {
    throw new ValidationError(`${body.studentEmail} is not an active student of this exam's batch`);
  }

  const row = await examStudentsDb.getOrCreateExamStudent(exam.examId, student.email);
  if (row.absent) {
    throw new ConflictError(`${student.email} is marked absent for this exam`);
  }

  return {
    exam,
    question,
    student: student as UserItem & { rollNo: string },
    imageKey: answerImageKey(exam.examId, student.rollNo, question.number),
  };
}

/** Parses a body with a schema and resolves its target. */
export async function targetFromRequest<T extends SubmitAnswerBody>(
  event: ApiEvent,
  ctx: AuthContext,
  schema: Parameters<typeof parseBody<T>>[0],
): Promise<{ body: T; target: AnswerTarget }> {
  const body = parseBody(schema, event);
  return { body, target: await resolveAnswerTarget(ctx, body) };
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
