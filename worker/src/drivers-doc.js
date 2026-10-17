import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DRIVERS_DOC = fileURLToPath(new URL('../DRIVERS.md', import.meta.url));

const START = "// ---- the student's code, copied exactly ----";
const START_PYTHON = "# ---- the student's code, copied exactly ----";
const END = "// ---- end of the student's code ----";
const END_PYTHON = "# ---- end of the student's code ----";

/**
 * The complete examples in DRIVERS.md (fenced blocks tagged "<language> example"), each with the
 * student's code (the lines between the two marker comments) pulled out.
 * Returns { python: { driverCode, correctedCode }, cpp: ..., java: ..., go: ... }.
 */
export function readDriverExamples(path = DRIVERS_DOC) {
  const markdown = readFileSync(path, 'utf8');
  const examples = {};
  for (const match of markdown.matchAll(/```(\w+) example\n([\s\S]*?)```/g)) {
    const [, language, source] = match;
    const driverCode = source;
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.trim() === START || l.trim() === START_PYTHON);
    const end = lines.findIndex((l) => l.trim() === END || l.trim() === END_PYTHON);
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`The ${language} example in DRIVERS.md has no student-code markers`);
    }
    examples[language] = { driverCode, correctedCode: lines.slice(start + 1, end).join('\n') };
  }
  return examples;
}

export function readDriversDoc(path = DRIVERS_DOC) {
  return readFileSync(path, 'utf8');
}
