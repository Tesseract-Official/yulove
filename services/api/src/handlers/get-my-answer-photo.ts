import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ANSWER_IMAGE_TYPE,
  BUCKET_ENV,
  ForbiddenError,
  NotFoundError,
  type MyAnswerPhotoResponse,
} from '@yulove/shared';
import { answersDb, examStudentsDb, examsDb, requireUser } from '@yulove/shared/server';
import { requiredEnv } from '../lib/answers.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { questionParam } from './get-answer.js';

/** How long a student's photo link works. Made fresh on every request. */
export const STUDENT_PHOTO_LINK_SECONDS = 5 * 60;

/**
 * GET /me/exams/{id}/questions/{q}/photo (student): a 5-minute link to the caller's own photo for
 * one question, exactly as it was sent for grading (the object at the answer's stored key, which
 * is what the latest attempt read). The student is always the caller: no student is named in the
 * path, so another student's photo cannot be asked for. The exam must be in the caller's batch and
 * published; anything else (including an exam that does not exist) is the same 403. The S3 key
 * never leaves the API.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ['STUDENT']);
  const examId = pathParam(event, 'id');
  const number = questionParam(event);

  const exam = await examsDb.getExam(examId);
  if (!exam || exam.status !== 'PUBLISHED' || !user.batchId || exam.batchId !== user.batchId) {
    throw new ForbiddenError('You cannot see photos for this exam');
  }
  if (!exam.questions.some((q) => q.number === number)) {
    throw new NotFoundError(`The exam has no question ${number}`);
  }
  if ((await examStudentsDb.getExamStudent(exam.examId, user.email))?.absent) {
    throw new NotFoundError('There is no photo for this question');
  }

  const answer = await answersDb.getAnswer({
    examId: exam.examId,
    studentEmail: user.email,
    questionNumber: number,
  });
  if (!answer?.imageKey) throw new NotFoundError('There is no photo for this question');

  const url = await getSignedUrl(
    new S3Client({}),
    new GetObjectCommand({
      Bucket: requiredEnv(BUCKET_ENV),
      Key: answer.imageKey,
      ResponseContentType: ANSWER_IMAGE_TYPE,
    }),
    { expiresIn: STUDENT_PHOTO_LINK_SECONDS },
  );
  const body: MyAnswerPhotoResponse = { url, expiresInSeconds: STUDENT_PHOTO_LINK_SECONDS };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
