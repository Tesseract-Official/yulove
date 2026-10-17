import { normaliseEmail, type SubmitAnswerResponse } from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { rerunAnswer } from '../lib/answers.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { questionParam } from './get-answer.js';

/**
 * POST /answers/{examId}/{studentEmail}/{q}/rerun (batch manager, teacher): grades the stored
 * photo again (see rerunAnswer).
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER', 'TEACHER']);
  const { target, attempt } = await rerunAnswer(ctx, {
    examId: pathParam(event, 'examId'),
    studentEmail: normaliseEmail(pathParam(event, 'studentEmail')),
    questionNumber: questionParam(event),
  });
  const body: SubmitAnswerResponse = {
    examId: target.exam.examId,
    studentEmail: target.student.email,
    questionNumber: target.question.number,
    attempt,
    status: 'QUEUED',
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
