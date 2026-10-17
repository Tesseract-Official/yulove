import type { UploadUrlResponse } from '@yulove/shared';

/** The photo could not be saved or sent; the message says what to do. */
export class PhotoUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoUploadError';
  }
}

/**
 * Sends the photo to S3 with the presigned POST the API made: every field exactly as given, then
 * the file last. This goes to S3, not to the API, so the sign-in token is never sent with it.
 */
export async function postToS3(
  presigned: UploadUrlResponse,
  photo: Blob,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<void> {
  if (photo.size > presigned.maxBytes) {
    throw new PhotoUploadError(
      'The photo is too large to send. Move closer to the page and retake it.',
    );
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(presigned.fields)) form.append(name, value);
  form.append('file', photo, 'answer.jpg');

  let response: Response;
  try {
    response = await fetchFn(presigned.url, { method: 'POST', body: form });
  } catch {
    throw new PhotoUploadError('The photo could not be sent. Check your connection and try again.');
  }
  if (!response.ok) {
    throw new PhotoUploadError(
      response.status === 403
        ? 'The upload link ran out. Press the button again to send the photo.'
        : `The photo could not be saved (error ${response.status}). Try again.`,
    );
  }
}
