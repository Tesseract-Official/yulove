import {
  assertOverrideAllowed,
  computeQuestionScore,
  normaliseEmail,
  NotFoundError,
  overrideBody,
  parseBody,
  roundScore,
  ValidationError,
  type Override,
  type SetOverrideResponse,
} from '@yulove/shared';
import {
  answerEntityKey,
  answersDb,
  examStudentsDb,
  recomputeExamTotal,
  requireUser,
  writeAudit,
} from '@yulove/shared/server';
import { loadExamInBatch } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { questionParam } from './get-answer.js';

/**
 * PUT /answers/{examId}/{studentEmail}/{q}/override (super admin only): sets, or with a null
 * score clears, an override of the question's score. The score must be from 0 to the question's
 * marks and a reason is required. Refused (409) for a student marked absent. The old and new
 * score and the reason are written to the audit log, and the exam total is worked out again. An
 * override stays through re-runs.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, []); // an empty list: super admin only
  const exam = await loadExamInBatch(ctx, pathParam(event, 'examId'));
  const email = normaliseEmail(pathParam(event, 'studentEmail'));
  const number = questionParam(event);
  const body = parseBody(overrideBody, event);

  const ref = exam.questions.find((q) => q.number === number);
  if (!ref) throw new NotFoundError(`The exam has no question ${number}`);
  const key = { examId: exam.examId, studentEmail: email, questionNumber: number };
  const answer = await answersDb.getAnswer(key);
  if (!answer) throw new NotFoundError('No answer has been submitted for this question');

  // Absent beats an override, so one on an absent student would do nothing.
  assertOverrideAllowed(await examStudentsDb.getExamStudent(exam.examId, email));

  let next: Override | undefined;
  if (body.score !== null) {
    if (body.score > ref.marks) {
      throw new ValidationError(`The score cannot be more than the question's ${ref.marks} marks`);
    }
    next = {
      score: roundScore(body.score),
      reason: body.reason,
      by: ctx.user.email,
      at: new Date().toISOString(),
    };
  }

  const before = {
    override: answer.override?.score ?? null,
    displayedScore: computeQuestionScore(ref.marks, answer, false),
  };
  const withoutOverride = { ...answer };
  delete withoutOverride.override;
  const after = {
    override: next?.score ?? null,
    displayedScore: computeQuestionScore(
      ref.marks,
      next ? { ...withoutOverride, override: next } : withoutOverride,
      false,
    ),
  };

  // Written first: no change to a score goes unrecorded.
  await writeAudit(
    answerEntityKey(exam.examId, email, number),
    ctx.user.email,
    next ? 'OVERRIDE_SCORE' : 'CLEAR_OVERRIDE',
    before,
    after,
    body.reason,
  );
  if (next) await answersDb.setOverride(key, next);
  else await answersDb.clearOverride(key);

  const total = await recomputeExamTotal(exam, email);
  const response: SetOverrideResponse = {
    examId: exam.examId,
    studentEmail: email,
    questionNumber: number,
    score: after.displayedScore,
    override: next ?? null,
    ...total,
  };
  return { status: 200, body: response };
}

export const handler = apiHandler(handle);
