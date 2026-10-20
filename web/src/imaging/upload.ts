import type { UploadUrlResponse } from '@yulove/shared';

/** The photo could not be saved or sent; the message says what to do. */
export class PhotoUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoUploadError';
  }
}

const TOO_LARGE = 'The photo is too large to send. Move closer to the page and retake it.';
const NO_CONNECTION = 'The photo could not be sent. Check your connection and try again.';
const LINK_RAN_OUT = 'The upload link ran out. Press the button again to send the photo.';

/** The form S3 expects: every field exactly as given, then the file last. */
function formFor(presigned: UploadUrlResponse, photo: Blob): FormData {
  if (photo.size > presigned.maxBytes) throw new PhotoUploadError(TOO_LARGE);
  const form = new FormData();
  for (const [name, value] of Object.entries(presigned.fields)) form.append(name, value);
  form.append('file', photo, 'answer.jpg');
  return form;
}

const failedWith = (status: number) =>
  status === 403 ? LINK_RAN_OUT : `The photo could not be saved (error ${status}). Try again.`;

/**
 * Sends the photo to S3 with the presigned POST the API made: every field exactly as given, then
 * the file last. This goes to S3, not to the API, so the sign-in token is never sent with it.
 */
export async function postToS3(
  presigned: UploadUrlResponse,
  photo: Blob,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<void> {
  const form = formFor(presigned, photo);

  let response: Response;
  try {
    response = await fetchFn(presigned.url, { method: 'POST', body: form });
  } catch {
    throw new PhotoUploadError(NO_CONNECTION);
  }
  if (!response.ok) {
    throw new PhotoUploadError(failedWith(response.status));
  }
}

/** The part of XMLHttpRequest the upload uses, so tests can stand in for it. */
export interface XhrLike {
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  };
  status: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  send(body: FormData): void;
  abort(): void;
}

export interface UploadOptions {
  /** Called with how much has been sent, from 0 to 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** For tests. */
  createXhr?: () => XhrLike;
  fetchFn?: typeof fetch;
}

/** The request never got an answer (no connection, or the browser refused it). */
class NoAnswer extends Error {}

function sendWithXhr(
  xhr: XhrLike,
  presigned: UploadUrlResponse,
  form: FormData,
  { onProgress, signal }: UploadOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else if (xhr.status === 0) {
        reject(new NoAnswer());
      } else {
        reject(new PhotoUploadError(failedWith(xhr.status)));
      }
    };
    xhr.onerror = () => reject(new NoAnswer());
    xhr.ontimeout = () => reject(new NoAnswer());
    xhr.onabort = () => reject(new PhotoUploadError('The upload was cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.open('POST', presigned.url);
    xhr.send(form);
  });
}

/**
 * Like postToS3, but reports progress while the photo goes up (fetch cannot do that). The form is
 * the same, and so are the error messages. If the request gets no answer at all, which can happen
 * when a browser or network objects to the progress listener, the photo is sent once more with a
 * plain request (no progress) before giving up.
 */
export async function uploadPhoto(
  presigned: UploadUrlResponse,
  photo: Blob,
  options: UploadOptions = {},
): Promise<void> {
  const form = formFor(presigned, photo);
  const createXhr = options.createXhr ?? (() => new XMLHttpRequest() as unknown as XhrLike);
  if (!options.createXhr && typeof XMLHttpRequest === 'undefined') {
    return postToS3(presigned, photo, options.fetchFn);
  }
  try {
    await sendWithXhr(createXhr(), presigned, form, options);
  } catch (error) {
    if (!(error instanceof NoAnswer)) throw error;
    await postToS3(presigned, photo, options.fetchFn);
    options.onProgress?.(1);
  }
}
