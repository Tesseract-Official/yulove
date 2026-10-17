import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  ANSWER_IMAGE_MAX_BYTES,
  ANSWER_IMAGE_TYPE,
  BUCKET_ENV,
  ConflictError,
  HttpError,
  messageDeduplicationId,
  messageGroupId,
  QUEUE_ENV,
  submitAnswerBody,
  transcribeMsg,
} from '@yulove/shared';
import { answersDb, requireUser } from '@yulove/shared/server';
import { requiredEnv, targetFromRequest } from '../lib/answers.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

const isMissing = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === 'NotFound' ||
  (error as { name?: string } | undefined)?.name === 'NoSuchKey' ||
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode ===
    404;

/**
 * POST /answers/submit (batch manager): starts grading for one uploaded photo. Checks that the
 * photo is in S3, counts a new attempt (status QUEUED), and queues it for transcription.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const { body, target } = await targetFromRequest(event, ctx, submitAnswerBody);

  try {
    const head = await new S3Client({}).send(
      new HeadObjectCommand({ Bucket: requiredEnv(BUCKET_ENV), Key: target.imageKey }),
    );
    if (head.ContentType !== ANSWER_IMAGE_TYPE) {
      throw new ConflictError('The uploaded file is not a JPEG. Upload the photo again.');
    }
    if ((head.ContentLength ?? 0) < 1 || (head.ContentLength ?? 0) > ANSWER_IMAGE_MAX_BYTES) {
      throw new ConflictError('The uploaded photo is empty or over 5 MB. Upload it again.');
    }
  } catch (error) {
    if (isMissing(error)) {
      throw new ConflictError('No photo has been uploaded for this answer yet. Upload it first.');
    }
    throw error;
  }

  const key = {
    examId: target.exam.examId,
    studentEmail: target.student.email,
    questionNumber: target.question.number,
  };
  const attempt = await answersDb.beginAttempt(key, target.imageKey);

  const message = transcribeMsg.parse({
    ...key,
    attempt,
    questionId: target.question.questionId,
    version: target.question.version,
  });
  try {
    await new SQSClient({}).send(
      new SendMessageCommand({
        QueueUrl: requiredEnv(QUEUE_ENV.transcribe),
        MessageBody: JSON.stringify(message),
        MessageGroupId: messageGroupId(key.examId, key.studentEmail),
        MessageDeduplicationId: messageDeduplicationId(
          key.examId,
          key.studentEmail,
          key.questionNumber,
          attempt,
        ),
      }),
    );
  } catch (error) {
    console.error('Could not queue an answer for transcription', error);
    await answersDb.markFailed(
      key,
      attempt,
      'WORKER_ERROR',
      'Could not queue the answer, submit again',
    );
    throw new HttpError(503, 'UNAVAILABLE', 'Could not queue the answer. Try submitting again.');
  }

  return {
    status: 200,
    body: {
      examId: key.examId,
      studentEmail: key.studentEmail,
      questionNumber: body.questionNumber,
      attempt,
      status: 'QUEUED',
    },
  };
}

export const handler = apiHandler(handle);
