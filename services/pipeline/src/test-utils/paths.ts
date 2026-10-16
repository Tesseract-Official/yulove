import { fileURLToPath } from 'node:url';

/** The real prompt file, so tests exercise exactly what ships. */
export const PROMPT_FILE = fileURLToPath(
  new URL('../../../../prompts/testgen.md', import.meta.url),
);
