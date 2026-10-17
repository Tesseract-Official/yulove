/** A photo of one answer page: at most this many bytes. */
export const ANSWER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ANSWER_IMAGE_TYPE = 'image/jpeg';
/** How long an upload link works. */
export const UPLOAD_URL_SECONDS = 10 * 60;

/**
 * S3 key of one answer photo: `answers/{examId}/{rollNo}/q{n}.jpg`. The roll number is encoded as
 * a single path segment (a no-op for ordinary roll numbers), so it can never add or remove
 * folders.
 */
export function answerImageKey(examId: string, rollNo: string, questionNumber: number): string {
  return `answers/${encodeURIComponent(examId)}/${encodeURIComponent(rollNo)}/q${questionNumber}.jpg`;
}

const normaliseCode = (code: string) => code.replace(/\r\n?/g, '\n').trim();

/**
 * Whether the driver contains the student's corrected code unchanged. Line endings and blank
 * space around the whole piece are ignored; nothing else is. This is the rule the worker applies
 * (worker/src/judge.js, containsUnchanged), and a test keeps the two in step.
 */
export function driverContainsCode(driverCode: string, correctedCode: string): boolean {
  const code = normaliseCode(correctedCode);
  return code !== '' && normaliseCode(driverCode).includes(code);
}
