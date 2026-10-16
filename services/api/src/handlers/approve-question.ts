import { ConflictError } from '@yulove/shared';
import { questionsDb, requireUser } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { loadQuestion } from '../lib/questions.js';

/** POST /questions/{id}/approve (teacher): NEEDS_REVIEW -> APPROVED, from no other state. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const question = await loadQuestion(ctx, pathParam(event, 'id'));

  const approved = await questionsDb.approveQuestion(question.questionId, question.version);
  if (!approved) {
    throw new ConflictError(
      `Only a question in NEEDS_REVIEW can be approved; this one is ${question.testStatus ?? 'not generated yet'}`,
    );
  }
  return {
    status: 200,
    body: { questionId: question.questionId, version: question.version, testStatus: 'APPROVED' },
  };
}

export const handler = apiHandler(handle);
