import { ConflictError, normaliseEmail, NotFoundError } from '@yulove/shared';
import { answersDb, requireUser } from '@yulove/shared/server';
import { findPhoto, resolveAnswerTarget, startAttempt } from '../lib/answers.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { questionParam } from './get-answer.js';

/**
 * POST /answers/{examId}/{studentEmail}/{q}/rerun (batch manager, teacher): grades the stored
 * photo again. It counts a new attempt, clears the failure and the busy count, sets QUEUED and
 * queues a new transcription. If a better photo was uploaded first (through upload-url, which
 * writes the same file), that is the one used. The old score stays until the new result replaces
 * it, and an override stays in place.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER', 'TEACHER']);
  const target = await resolveAnswerTarget(ctx, {
    examId: pathParam(event, 'examId'),
    studentEmail: normaliseEmail(pathParam(event, 'studentEmail')),
    questionNumber: questionParam(event),
  });

  const answer = await answersDb.getAnswer({
    examId: target.exam.examId,
    studentEmail: target.student.email,
    questionNumber: target.question.number,
  });
  if (!answer) throw new NotFoundError('No answer has been submitted for this question');
  if (!answer.imageKey) throw new ConflictError('This answer has no photo to grade again');

  // upload-url always writes to the same key, so a photo uploaded just now is the one found
  // first; an older stored key is only a fallback.
  const imageKey = await findPhoto([target.imageKey, answer.imageKey]);

  const attempt = await startAttempt(target, imageKey);
  return {
    status: 200,
    body: {
      examId: target.exam.examId,
      studentEmail: target.student.email,
      questionNumber: target.question.number,
      attempt,
      status: 'QUEUED',
    },
  };
}

export const handler = apiHandler(handle);
