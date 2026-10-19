/**
 * Reasons stored for people to read (why an answer or a question's tests failed) are complete
 * sentences. Browser-safe: used by the pipeline and the web app.
 */

/** Adds a full stop unless the text already ends a sentence. Empty text stays empty. */
export function endSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Why test generation failed when Gemini was busy. Shown to the teacher as it is. */
export const TESTGEN_BUSY_REASON =
  'The tests could not be made because Gemini is busy. Wait a minute, then press Generate tests again.';

/** The text this used to be, still stored on questions that failed before the wording changed. */
export const LEGACY_TESTGEN_BUSY_REASON = 'Gemini is busy right now, try generating again';

/** Why an answer could not be read when Gemini stayed busy. Shown to batch managers and teachers. */
export const TRANSCRIBE_BUSY_REASON =
  'Gemini is busy, so this answer could not be read. Wait a minute, then press Grade again.';

/** The text this used to be, still stored on answers that failed before the wording changed. */
export const LEGACY_TRANSCRIBE_BUSY_REASON = 'Transcription service busy, re-run';

const LEAD = 'The tests could not be made';

/**
 * What the teacher reads when test generation failed. A reason that already says the tests could
 * not be made is shown as it is; any other reason is put after that sentence, with a full stop,
 * and the way to try again.
 */
export function testFailureText(reason: string | undefined): string {
  const text = reason?.trim() ?? '';
  if (text === '') return `${LEAD}. No reason was given. Press Generate tests to try again.`;
  if (text === LEGACY_TESTGEN_BUSY_REASON) return TESTGEN_BUSY_REASON;
  if (text.startsWith(LEAD)) return endSentence(text);
  return `${LEAD}. ${endSentence(text)} Press Generate tests to try again.`;
}

/** The same for an answer's failure detail, mapping the old busy text to the new one. */
export function answerFailureText(detail: string | undefined): string | undefined {
  const text = detail?.trim();
  if (!text) return undefined;
  return text === LEGACY_TRANSCRIBE_BUSY_REASON ? TRANSCRIBE_BUSY_REASON : endSentence(text);
}
