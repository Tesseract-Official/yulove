import {
  APPEAL_STATUSES,
  mapLimit,
  ValidationError,
  type AppealItem,
  type AppealStatus,
} from '@yulove/shared';
import { appealsDb, requireUser, usersDb } from '@yulove/shared/server';
import { loadExamInBatch } from '../lib/exams.js';
import { apiHandler, queryParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /appeals?examId=&status= (batch manager, teacher): the appeals of one exam of a batch they
 * are assigned to, newest first, with the student's name and roll number.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER', 'TEACHER']);

  const examId = queryParam(event, 'examId')?.trim();
  if (!examId) throw new ValidationError('examId is required');
  const statusText = queryParam(event, 'status')?.trim();
  if (statusText && !(APPEAL_STATUSES as readonly string[]).includes(statusText)) {
    throw new ValidationError(`status must be one of ${APPEAL_STATUSES.join(', ')}`);
  }
  const status = statusText ? (statusText as AppealStatus) : undefined;

  const exam = await loadExamInBatch(ctx, examId);
  const appeals = (await appealsDb.listAppealsByExam(exam.examId, status)).sort(
    (a: AppealItem, b: AppealItem) => b.createdAt.localeCompare(a.createdAt),
  );

  const students = await mapLimit([...new Set(appeals.map((a) => a.studentEmail))], 10, (email) =>
    usersDb.getUser(email),
  );
  const byEmail = new Map(students.flatMap((u) => (u ? [[u.email, u] as const] : [])));

  return {
    status: 200,
    body: {
      examId: exam.examId,
      appeals: appeals.map((a) => ({
        ...a,
        studentName: byEmail.get(a.studentEmail)?.name,
        rollNo: byEmail.get(a.studentEmail)?.rollNo,
      })),
    },
  };
}

export const handler = apiHandler(handle);
