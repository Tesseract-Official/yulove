import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ANSWER_IMAGE_TYPE,
  BUCKET_ENV,
  computeQuestionScore,
  type AnswerDetailResponse,
  normaliseEmail,
  NotFoundError,
  ValidationError,
} from '@yulove/shared';
import { answersDb, examStudentsDb, requireUser } from '@yulove/shared/server';
import { requiredEnv } from '../lib/answers.js';
import { loadExamInBatch, mayManageExam } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

export const IMAGE_LINK_SECONDS = 15 * 60;

/** The question number from the path: a whole number of 1 or more. */
export function questionParam(event: ApiEvent): number {
  const text = pathParam(event, 'q');
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1) throw new ValidationError(`"${text}" is not a question number`);
  return n;
}

/**
 * GET /answers/{examId}/{studentEmail}/{q} (batch manager, teacher): everything about one answer:
 * a 15-minute link to the photo, the raw and corrected transcription, the fixes, the language and
 * complexity, the verdicts, the score and the status.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER', 'TEACHER']);
  const exam = await loadExamInBatch(ctx, pathParam(event, 'examId'));
  const email = normaliseEmail(pathParam(event, 'studentEmail'));
  const number = questionParam(event);

  const ref = exam.questions.find((q) => q.number === number);
  if (!ref) throw new NotFoundError(`The exam has no question ${number}`);
  const key = { examId: exam.examId, studentEmail: email, questionNumber: number };
  const answer = await answersDb.getAnswer(key);
  if (!answer) throw new NotFoundError('No answer has been submitted for this question');

  const row = await examStudentsDb.getExamStudent(exam.examId, email);
  const absent = row?.absent === true;

  const imageUrl = answer.imageKey
    ? await getSignedUrl(
        new S3Client({}),
        new GetObjectCommand({
          Bucket: requiredEnv(BUCKET_ENV),
          Key: answer.imageKey,
          ResponseContentType: ANSWER_IMAGE_TYPE,
        }),
        { expiresIn: IMAGE_LINK_SECONDS },
      )
    : undefined;

  const body: AnswerDetailResponse = {
    examId: exam.examId,
    studentEmail: email,
    questionNumber: number,
    marks: ref.marks,
    absent,
    status: answer.status,
    attempt: answer.attempt,
    failReason: answer.failReason,
    failDetail: answer.failDetail,
    imageUrl,
    imageExpiresInSeconds: imageUrl ? IMAGE_LINK_SECONDS : undefined,
    language: answer.language,
    rawTranscription: answer.rawTranscription,
    correctedCode: answer.correctedCode,
    fixes: answer.fixes ?? [],
    estimatedComplexity: answer.estimatedComplexity,
    meetsComplexity: answer.meetsComplexity,
    testsPassed: answer.testsPassed,
    testsTotal: answer.testsTotal,
    verdicts: answer.verdicts ?? [],
    score: computeQuestionScore(ref.marks, answer, absent),
    override: answer.override,
    canOverride: mayManageExam(ctx, exam),
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
