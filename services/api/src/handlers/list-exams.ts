import { mapLimit, ValidationError, type ExamItem, type ExamListResponse } from '@yulove/shared';
import { examsDb, makeActorResolver, requireUser } from '@yulove/shared/server';
import { apiHandler, queryParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /exams?batchId= (teacher, batch manager): the exams of one batch the caller is assigned to.
 * Without `batchId` it lists the exams of every batch the caller is assigned to; a super admin
 * gets every exam. Any teacher or batch manager of a batch sees its exams, not only the teacher who
 * created one (the same rule as the status board). `createdBy` is left out when a super admin made
 * the exam and the caller is not one.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER', 'BATCH_MANAGER']);
  const batchId = queryParam(event, 'batchId')?.trim();
  if (batchId === '') throw new ValidationError('batchId must not be empty');

  let exams: ExamItem[];
  if (batchId !== undefined) {
    ctx.assertBatchAccess(batchId);
    exams = await examsDb.listExamsByBatch(batchId);
  } else if (ctx.user.role === 'SUPER_ADMIN') {
    exams = await examsDb.listAllExams();
  } else {
    const perBatch = await mapLimit([...new Set(ctx.user.batchIds ?? [])], 10, (id) =>
      examsDb.listExamsByBatch(id),
    );
    exams = perBatch.flat();
  }

  const actors = makeActorResolver(ctx.user.role);
  const creators = new Map<string, string | undefined>();
  for (const email of new Set(exams.map((e) => e.createdBy))) {
    creators.set(email, await actors.visible(email));
  }

  const body: ExamListResponse = {
    exams: exams
      .map((exam) => ({
        examId: exam.examId,
        batchId: exam.batchId,
        title: exam.title,
        date: exam.date,
        status: exam.status,
        questionCount: exam.questions.length,
        ...(creators.get(exam.createdBy) ? { createdBy: exam.createdBy } : {}),
      }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)),
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
