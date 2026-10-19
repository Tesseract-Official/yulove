import {
  APPEAL_STATUSES,
  mapLimit,
  ValidationError,
  type AppealItem,
  type AppealListResponse,
  type AppealStatus,
} from '@yulove/shared';
import { appealsDb, requireUser, usersDb } from '@yulove/shared/server';
import { loadReviewableExam } from '../lib/exams.js';
import { apiHandler, queryParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /appeals?examId=&status= (teacher of the exam's batch, or a super admin): the appeals of one
 * exam, newest first, with the student's name and roll number.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);

  const examId = queryParam(event, 'examId')?.trim();
  if (!examId) throw new ValidationError('examId is required');
  const statusText = queryParam(event, 'status')?.trim();
  if (statusText && !(APPEAL_STATUSES as readonly string[]).includes(statusText)) {
    throw new ValidationError(`status must be one of ${APPEAL_STATUSES.join(', ')}`);
  }
  const status = statusText ? (statusText as AppealStatus) : undefined;

  const exam = await loadReviewableExam(ctx, examId);
  const appeals = (await appealsDb.listAppealsByExam(exam.examId, status)).sort(
    (a: AppealItem, b: AppealItem) => b.createdAt.localeCompare(a.createdAt),
  );

  const students = await mapLimit([...new Set(appeals.map((a) => a.studentEmail))], 10, (email) =>
    usersDb.getUser(email),
  );
  const byEmail = new Map(students.flatMap((u) => (u ? [[u.email, u] as const] : [])));

  const body: AppealListResponse = {
    examId: exam.examId,
    appeals: appeals.map((a) => ({
      ...a,
      studentName: byEmail.get(a.studentEmail)?.name,
      rollNo: byEmail.get(a.studentEmail)?.rollNo,
    })),
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
