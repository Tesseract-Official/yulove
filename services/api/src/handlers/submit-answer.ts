import { submitAnswerBody, type SubmitAnswerResponse } from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { checkPhoto, startAttempt, targetFromRequest } from '../lib/answers.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * POST /answers/submit (batch manager): starts grading for one uploaded photo. Checks that the
 * photo is in S3, counts a new attempt (status QUEUED), and queues it for transcription.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const { body, target } = await targetFromRequest(event, ctx, submitAnswerBody);

  await checkPhoto(target.imageKey);
  const attempt = await startAttempt(target, target.imageKey);

  const response: SubmitAnswerResponse = {
    examId: target.exam.examId,
    studentEmail: target.student.email,
    questionNumber: body.questionNumber,
    attempt,
    status: 'QUEUED',
  };
  return { status: 200, body: response };
}

export const handler = apiHandler(handle);
