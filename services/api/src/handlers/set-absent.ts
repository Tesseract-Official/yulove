import { normaliseEmail, NotFoundError, parseBody, setAbsentBody } from '@yulove/shared';
import { examStudentsDb, recomputeExamTotal, requireUser, usersDb } from '@yulove/shared/server';
import { loadExamInBatch } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * PUT /exams/{id}/students/{email}/absent (batch manager): marks or unmarks a student absent.
 * While absent, every question scores 0 and the exam total is 0; unmarking works the total out
 * again from their answers.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const exam = await loadExamInBatch(ctx, pathParam(event, 'id'));
  const body = parseBody(setAbsentBody, event);

  const email = normaliseEmail(pathParam(event, 'email'));
  const student = await usersDb.getUser(email);
  if (!student || student.role !== 'STUDENT' || student.batchId !== exam.batchId) {
    throw new NotFoundError(`${email} is not a student of this exam's batch`);
  }

  await examStudentsDb.setAbsent(exam.examId, email, body.absent);
  const total = await recomputeExamTotal(exam, email);

  return {
    status: 200,
    body: { examId: exam.examId, studentEmail: email, absent: body.absent, ...total },
  };
}

export const handler = apiHandler(handle);
