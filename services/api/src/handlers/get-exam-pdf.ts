import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET_ENV, ConflictError, type ExamPdfLinkResponse } from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { loadManagedExam } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

export const LINK_SECONDS = 15 * 60;

/** A file name made of letters, digits and dashes. */
export function downloadName(title: string, date: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'exam'}-${date}.pdf`;
}

/** GET /exams/{id}/pdf (teacher): a download link for the paper, valid for 15 minutes. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const exam = await loadManagedExam(ctx, pathParam(event, 'id'));

  if (!exam.pdfKey || (exam.status !== 'READY' && exam.status !== 'PUBLISHED')) {
    throw new ConflictError('This exam has no PDF yet. Generate it first.');
  }
  const bucket = process.env[BUCKET_ENV];
  if (!bucket) throw new Error(`Missing environment variable ${BUCKET_ENV}`);

  const filename = downloadName(exam.title, exam.date);
  const url = await getSignedUrl(
    new S3Client({}),
    new GetObjectCommand({
      Bucket: bucket,
      Key: exam.pdfKey,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
    { expiresIn: LINK_SECONDS },
  );
  const body: ExamPdfLinkResponse = { url, expiresInSeconds: LINK_SECONDS, filename };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
