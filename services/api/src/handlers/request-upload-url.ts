import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  ANSWER_IMAGE_MAX_BYTES,
  ANSWER_IMAGE_TYPE,
  BUCKET_ENV,
  requestUploadUrlBody,
  type UploadUrlResponse,
  UPLOAD_URL_SECONDS,
} from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { requiredEnv, targetFromRequest } from '../lib/answers.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * POST /answers/upload-url (batch manager): a presigned S3 POST for one answer photo. The upload
 * goes straight to S3, so it can be larger than API Gateway allows; the signed policy limits it to
 * one key, JPEG, 1 byte to 5 MB, for 10 minutes.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const { target } = await targetFromRequest(event, ctx, requestUploadUrlBody);

  const { url, fields } = await createPresignedPost(new S3Client({}), {
    Bucket: requiredEnv(BUCKET_ENV),
    Key: target.imageKey,
    Expires: UPLOAD_URL_SECONDS,
    Conditions: [
      ['eq', '$Content-Type', ANSWER_IMAGE_TYPE],
      ['content-length-range', 1, ANSWER_IMAGE_MAX_BYTES],
    ],
    Fields: { 'Content-Type': ANSWER_IMAGE_TYPE },
  });

  const body: UploadUrlResponse = {
    url,
    fields,
    key: target.imageKey,
    maxBytes: ANSWER_IMAGE_MAX_BYTES,
    expiresInSeconds: UPLOAD_URL_SECONDS,
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
