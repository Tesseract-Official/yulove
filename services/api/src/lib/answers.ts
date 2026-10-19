import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  ANSWER_IMAGE_MAX_BYTES,
  ANSWER_IMAGE_TYPE,
  answerImageKey,
  BUCKET_ENV,
  ConflictError,
  HttpError,
  messageDeduplicationId,
  messageGroupId,
  NotFoundError,
  parseBody,
  QUEUE_ENV,
  transcribeMsg,
  ValidationError,
  type ExamItem,
  type ExamQuestionRef,
  type UserItem,
  type SubmitAnswerBody,
} from '@yulove/shared';
import {
  answersDb,
  examStudentsDb,
  examsDb,
  usersDb,
  type AuthContext,
} from '@yulove/shared/server';
import type { ApiEvent } from './http.js';

/** Everything the upload and submit routes know once the checks have passed. */
export interface AnswerTarget {
  exam: ExamItem;
  question: ExamQuestionRef;
  student: UserItem & { rollNo: string };
  /** `answers/{examId}/{rollNo}/q{n}.jpg` */
  imageKey: string;
}

/**
 * The checks both answer routes share, in this order:
 * - the exam exists, and the caller has its batch (403);
 * - the exam is READY or PUBLISHED (409);
 * - the question number is one of the exam's (422);
 * - the student is an active student of the exam's batch (422);
 * - the student is not marked absent (409).
 * Reads the student's ExamStudents row, creating it if the student was imported after the exam.
 */
export async function resolveAnswerTarget<T extends SubmitAnswerBody>(
  ctx: AuthContext,
  body: T,
): Promise<AnswerTarget> {
  const exam = await examsDb.getExam(body.examId);
  if (!exam) throw new NotFoundError(`No exam ${body.examId}`);
  ctx.assertBatchAccess(exam.batchId);

  if (exam.status !== 'READY' && exam.status !== 'PUBLISHED') {
    throw new ConflictError('This exam is not ready for answers yet (its status is DRAFT)');
  }
  const question = exam.questions.find((q) => q.number === body.questionNumber);
  if (!question) {
    throw new ValidationError(`The exam has no question ${body.questionNumber}`);
  }

  const student = await usersDb.getUser(body.studentEmail);
  if (
    !student ||
    student.role !== 'STUDENT' ||
    student.batchId !== exam.batchId ||
    student.active === false ||
    !student.rollNo
  ) {
    throw new ValidationError(`${body.studentEmail} is not an active student of this exam's batch`);
  }

  const row = await examStudentsDb.getOrCreateExamStudent(exam.examId, student.email);
  if (row.absent) {
    throw new ConflictError(`${student.email} is marked absent for this exam`);
  }

  return {
    exam,
    question,
    student: student as UserItem & { rollNo: string },
    imageKey: answerImageKey(exam.examId, student.rollNo, question.number),
  };
}

/** Parses a body with a schema and resolves its target. */
export async function targetFromRequest<T extends SubmitAnswerBody>(
  event: ApiEvent,
  ctx: AuthContext,
  schema: Parameters<typeof parseBody<T>>[0],
): Promise<{ body: T; target: AnswerTarget }> {
  const body = parseBody(schema, event);
  return { body, target: await resolveAnswerTarget(ctx, body) };
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const isMissing = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === 'NotFound' ||
  (error as { name?: string } | undefined)?.name === 'NoSuchKey' ||
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode ===
    404;

/** The photo is not in S3 (a 409: upload it first). */
export class MissingPhotoError extends ConflictError {
  constructor() {
    super('No photo has been uploaded for this answer yet. Upload it first.');
  }
}

/**
 * Checks that the photo is in S3, is a JPEG and is between 1 byte and 5 MB. A missing photo is a
 * 409 ("upload it first"); other S3 errors are passed on.
 */
export async function checkPhoto(imageKey: string): Promise<void> {
  try {
    const head = await new S3Client({}).send(
      new HeadObjectCommand({ Bucket: requiredEnv(BUCKET_ENV), Key: imageKey }),
    );
    if (head.ContentType !== ANSWER_IMAGE_TYPE) {
      throw new ConflictError('The uploaded file is not a JPEG. Upload the photo again.');
    }
    if ((head.ContentLength ?? 0) < 1 || (head.ContentLength ?? 0) > ANSWER_IMAGE_MAX_BYTES) {
      throw new ConflictError('The uploaded photo is empty or over 5 MB. Upload it again.');
    }
  } catch (error) {
    if (isMissing(error)) throw new MissingPhotoError();
    throw error;
  }
}

/** The first of these keys that has a valid photo; a missing photo moves on to the next key. */
export async function findPhoto(keys: readonly string[]): Promise<string> {
  const unique = [...new Set(keys)];
  let first: MissingPhotoError | undefined;
  for (const key of unique) {
    try {
      await checkPhoto(key);
      return key;
    } catch (error) {
      if (!(error instanceof MissingPhotoError)) throw error;
      first ??= error;
    }
  }
  throw first ?? new MissingPhotoError();
}

/** Counts a new attempt on the photo at `imageKey` and queues it for transcription. */
export async function startAttempt(target: AnswerTarget, imageKey: string): Promise<number> {
  const key = {
    examId: target.exam.examId,
    studentEmail: target.student.email,
    questionNumber: target.question.number,
  };
  // Counts the attempt, sets QUEUED, clears any earlier failure and the Gemini busy count.
  const attempt = await answersDb.beginAttempt(key, imageKey);

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
      'Could not queue the answer. Submit it again.',
    );
    throw new HttpError(503, 'UNAVAILABLE', 'Could not queue the answer. Try submitting again.');
  }
  return attempt;
}

/**
 * Grades an answer again (batch manager, teacher, or a RERUN appeal): the same checks as a
 * submission (READY or PUBLISHED exam, valid question, active student, not absent), the answer
 * and its photo must exist, then a new attempt is counted (QUEUED, failure and busy count
 * cleared) and a transcription is queued. A photo uploaded just before is the one used, since
 * upload-url writes the same key. The old score and any override stay until a new result replaces
 * the score.
 */
export async function rerunAnswer(
  ctx: AuthContext,
  ref: { examId: string; studentEmail: string; questionNumber: number },
): Promise<{ target: AnswerTarget; attempt: number }> {
  const target = await resolveAnswerTarget(ctx, ref);

  const answer = await answersDb.getAnswer({
    examId: target.exam.examId,
    studentEmail: target.student.email,
    questionNumber: target.question.number,
  });
  if (!answer) throw new NotFoundError('No answer has been submitted for this question');
  if (!answer.imageKey) throw new ConflictError('This answer has no photo to grade again');

  const imageKey = await findPhoto([target.imageKey, answer.imageKey]);
  const attempt = await startAttempt(target, imageKey);
  return { target, attempt };
}
