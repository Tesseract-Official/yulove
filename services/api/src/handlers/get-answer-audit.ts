import { normaliseEmail, NotFoundError } from '@yulove/shared';
import { answerEntityKey, answersDb, auditLogDb, requireUser } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { questionParam } from './get-answer.js';

/**
 * GET /answers/{examId}/{studentEmail}/{q}/audit (super admin only): everything recorded about
 * changes to this answer's score, newest first.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  await requireUser(event, []); // an empty list: super admin only
  const examId = pathParam(event, 'examId');
  const email = normaliseEmail(pathParam(event, 'studentEmail'));
  const number = questionParam(event);

  const answer = await answersDb.getAnswer({ examId, studentEmail: email, questionNumber: number });
  if (!answer) throw new NotFoundError('No answer has been submitted for this question');

  const history = await auditLogDb.listAuditForEntity(answerEntityKey(examId, email, number));
  const entries = history
    .map(({ timestamp, actor, action, before, after, reason }) => ({
      timestamp,
      actor,
      action,
      before,
      after,
      reason,
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { status: 200, body: { examId, studentEmail: email, questionNumber: number, entries } };
}

export const handler = apiHandler(handle);
