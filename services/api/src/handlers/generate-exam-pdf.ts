import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BUCKET_ENV, ConflictError, type ExamPdfResponse } from '@yulove/shared';
import { batchesDb, examsDb, requireUser } from '@yulove/shared/server';
import { renderExamPdf } from '../lib/exam-pdf.js';
import { loadManagedExam, loadQuestionVersions, sameQuestions } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * POST /exams/{id}/pdf (teacher): renders the exam paper, stores it at exams/{examId}/paper.pdf and
 * marks the exam READY. A published exam keeps its status, so the paper can be printed again.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const exam = await loadManagedExam(ctx, pathParam(event, 'id'));

  const bucket = process.env[BUCKET_ENV];
  if (!bucket) throw new Error(`Missing environment variable ${BUCKET_ENV}`);

  // A question edited since the exam was made has lost its approval and its tests.
  const versions = await loadQuestionVersions(exam.questions);
  const unusable = versions
    .filter(({ item }) => item?.testStatus !== 'APPROVED')
    .map(({ ref }) => `${ref.questionId} v${ref.version}`);
  if (unusable.length > 0) {
    throw new ConflictError(
      `These questions are no longer approved: ${unusable.join(', ')}. Approve them again or change the exam.`,
    );
  }

  const batch = await batchesDb.getBatch(exam.batchId);
  const { buffer, pageCount } = await renderExamPdf({
    title: exam.title,
    batchName: batch?.name ?? exam.batchId,
    date: exam.date,
    questions: versions.map(({ ref, item }) => ({
      number: ref.number,
      marks: ref.marks,
      question: item!,
    })),
  });

  const pdfKey = `exams/${exam.examId}/paper.pdf`;
  await new S3Client({}).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: pdfKey,
      Body: buffer,
      ContentType: 'application/pdf',
    }),
  );

  // If the exam was edited while we were rendering, this paper is already out of date.
  const latest = await examsDb.getExam(exam.examId);
  if (
    !latest ||
    latest.title !== exam.title ||
    latest.date !== exam.date ||
    !sameQuestions(latest.questions, exam.questions)
  ) {
    throw new ConflictError('The exam was changed while its PDF was being made. Try again.');
  }

  const status = exam.status === 'PUBLISHED' ? 'PUBLISHED' : 'READY';
  await examsDb.updateExam(exam.examId, { pdfKey, status });
  const body: ExamPdfResponse = { examId: exam.examId, status, pdfKey, pageCount };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
