import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  createAppealBody,
  NotFoundError,
  parseBody,
  ValidationError,
  type AppealItem,
  type CreateAppealResponse,
} from '@yulove/shared';
import { answersDb, appealsDb, examStudentsDb, requireUser } from '@yulove/shared/server';
import { loadPublishedExam } from '../lib/student.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * POST /appeals (student): appeal one question of their own, on an exam that is published. One
 * open appeal per question at a time.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['STUDENT']);
  const body = parseBody(createAppealBody, event);
  const student = ctx.user.email;

  // The student is always the caller; the body cannot name anyone else.
  const exam = await loadPublishedExam(ctx.user, body.examId);
  if (!exam.questions.some((q) => q.number === body.questionNumber)) {
    throw new ValidationError(`The exam has no question ${body.questionNumber}`);
  }
  if ((await examStudentsDb.getExamStudent(exam.examId, student))?.absent) {
    throw new ConflictError('You were marked absent for this exam, so there is nothing to appeal');
  }

  const key = { examId: exam.examId, studentEmail: student, questionNumber: body.questionNumber };
  if (!(await answersDb.getAnswer(key))) {
    throw new NotFoundError('There is no answer to appeal for this question');
  }

  const appealId = randomUUID();
  if (!(await answersDb.claimAppeal(key, appealId))) {
    await releaseIfStale(key);
    if (!(await answersDb.claimAppeal(key, appealId))) {
      throw new ConflictError('You already have an open appeal on this question');
    }
  }

  const appeal: AppealItem = {
    appealId,
    examId: exam.examId,
    studentEmail: student,
    questionNumber: body.questionNumber,
    message: body.message,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
  };
  try {
    await appealsDb.createAppeal(appeal);
  } catch (error) {
    await answersDb.releaseAppeal(key, appealId);
    throw error;
  }

  const response: CreateAppealResponse = { appeal };
  return { status: 201, body: response };
}

/**
 * The open-appeal mark can outlive its appeal (a crash between the two writes). If the appeal it
 * points to is missing or no longer OPEN, clear it so the student is not locked out.
 */
async function releaseIfStale(key: {
  examId: string;
  studentEmail: string;
  questionNumber: number;
}): Promise<void> {
  const answer = await answersDb.getAnswer(key);
  if (!answer?.openAppealId) return;
  const marked = await appealsDb.getAppeal(answer.openAppealId);
  if (!marked || marked.status !== 'OPEN') {
    await answersDb.releaseAppeal(key, answer.openAppealId);
  }
}

export const handler = apiHandler(handle);
