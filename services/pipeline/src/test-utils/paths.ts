import { fileURLToPath } from 'node:url';

/** The real prompt file, so tests exercise exactly what ships. */
export const PROMPT_FILE = fileURLToPath(
  new URL('../../../../prompts/testgen.md', import.meta.url),
);

export const TRANSCRIBE_PROMPT_FILE = fileURLToPath(
  new URL('../../../../prompts/transcribe.md', import.meta.url),
);

/** worker/DRIVERS.md, which the Transcribe Lambda ships with. */
export const DRIVERS_FILE = fileURLToPath(
  new URL('../../../../worker/DRIVERS.md', import.meta.url),
);
