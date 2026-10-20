import {
  normaliseEmail,
  auditEntryVisibleTo,
  NotFoundError,
  type AuditEntry,
  type AuditHistoryResponse,
} from '@yulove/shared';
import { answerEntityKey, answersDb, auditLogDb, requireUser } from '@yulove/shared/server';
import { loadReviewableExam } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { questionParam } from './get-answer.js';

/**
 * GET /answers/{examId}/{studentEmail}/{q}/audit (teacher of the exam's batch, or a super admin):
 * everything recorded about changes to this answer's score, newest first, with who made each.
 * A teacher gets only the entries teachers made: a super admin's are left out here, on the
 * server, so they are not in the response at all. A super admin gets every entry.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const examId = pathParam(event, 'examId');
  await loadReviewableExam(ctx, examId);
  const email = normaliseEmail(pathParam(event, 'studentEmail'));
  const number = questionParam(event);

  const answer = await answersDb.getAnswer({ examId, studentEmail: email, questionNumber: number });
  if (!answer) throw new NotFoundError('No answer has been submitted for this question');

  const history = await auditLogDb.listAuditForEntity(answerEntityKey(examId, email, number));
  const entries: AuditEntry[] = history
    .filter((entry) => auditEntryVisibleTo(ctx.user.role, entry.actorRole))
    .map(({ timestamp, actor, actorRole, action, before, after, reason }) => ({
      timestamp,
      actor,
      ...(actorRole ? { actorRole } : {}),
      action,
      before,
      after,
      reason,
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const body: AuditHistoryResponse = {
    examId,
    studentEmail: email,
    questionNumber: number,
    entries,
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
