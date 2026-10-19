import {
  ConflictError,
  NotFoundError,
  parseBody,
  updateAppealBody,
  type AppealItem,
  type UpdateAppealResponse,
} from '@yulove/shared';
import { answersDb, appealsDb, requireUser } from '@yulove/shared/server';
import { rerunAnswer } from '../lib/answers.js';
import { loadReviewableExam } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * PUT /appeals/{id} (teacher of the exam's batch, or a super admin): close an appeal with a
 * note, or have the answer graded again (RERUN). The reviewer is recorded as `handledBy`. The student sees
 * the status and the note.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const body = parseBody(updateAppealBody, event);

  const appeal = await appealsDb.getAppeal(pathParam(event, 'id'));
  if (!appeal) throw new NotFoundError('No such appeal');
  await loadReviewableExam(ctx, appeal.examId);

  if (appeal.status === 'CLOSED') throw new ConflictError('This appeal is already closed');
  if (body.status === 'RERUN' && appeal.status !== 'OPEN') {
    throw new ConflictError('This appeal has already been sent to be graded again');
  }

  const key = {
    examId: appeal.examId,
    studentEmail: appeal.studentEmail,
    questionNumber: appeal.questionNumber,
  };
  let attempt: number | undefined;
  if (body.status === 'RERUN') {
    // First, so that an answer that cannot be graded again leaves the appeal open.
    ({ attempt } = await rerunAnswer(ctx, key));
  }

  const changes = {
    status: body.status,
    handledBy: ctx.user.email,
    ...(body.note ? { note: body.note } : {}),
  };
  await appealsDb.updateAppeal(appeal.appealId, changes);
  // The question has no open appeal any more; the student may appeal again after a re-grade.
  await answersDb.releaseAppeal(key, appeal.appealId);

  const updated: AppealItem = { ...appeal, ...changes, handledBy: ctx.user.email };
  const response: UpdateAppealResponse = {
    appeal: updated,
    ...(attempt !== undefined ? { attempt } : {}),
  };
  return { status: 200, body: response };
}

export const handler = apiHandler(handle);
