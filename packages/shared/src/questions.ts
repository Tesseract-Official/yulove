import { z } from 'zod';
import { COMPARE_MODES } from './enums.js';
import type { Example } from './types.js';

/**
 * The input/output convention, in the words docs/DESIGN.md uses (a test checks they match).
 *
 * - A test input is ONE JSON object whose keys are exactly the signature's parameter names.
 * - reference.py reads that object from stdin, calls the solution with those arguments, and
 *   prints the result as one line of JSON (`print(json.dumps(result))`).
 * - Student drivers follow the same convention: read the object from stdin, call the student's
 *   function, print the result as one line of JSON.
 * - The worker parses both the program's output and the expected output as JSON and compares the
 *   values (according to the question's compare mode), never the raw text.
 */
export const IO_CONVENTION = [
  "Input/output convention: every test input is one JSON object keyed by the signature's parameter names, and every program (reference or student driver) prints its result as one line of JSON.",
  'The worker compares parsed JSON values, so formatting differences between languages (spacing, 2 vs 2.0) never fail a test.',
] as const;

/** Every question has exactly 10 tests. Positions 0-6 are small, 7-9 are large. */
export const TEST_COUNTS = { small: 7, large: 3, total: 10 } as const;

export function testKind(index: number): 'small' | 'large' {
  return index < TEST_COUNTS.small ? 'small' : 'large';
}

/** S3 keys for one question version, all under questions/. */
export function questionKeys(questionId: string, version: number) {
  const prefix = `questions/${questionId}/v${version}/`;
  return {
    prefix,
    reference: `${prefix}reference.py`,
    generator: `${prefix}generator.py`,
    smallInputs: `${prefix}small-inputs.json`,
    tests: `${prefix}tests.json`,
  };
}

/** tests.json, written by the worker after it has run the reference solution on every input. */
export const testsFileSchema = z.object({
  questionId: z.string().min(1),
  version: z.number().int().positive(),
  tests: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .max(TEST_COUNTS.total - 1),
        kind: z.enum(['small', 'large']),
        input: z.string(),
        expected: z.string(),
      }),
    )
    .length(TEST_COUNTS.total),
});
export type TestsFile = z.infer<typeof testsFileSchema>;

/** The question fields that decide what the tests must look like. Title and examples are not among them. */
export const TEST_AFFECTING_FIELDS = [
  'statement',
  'ioDescription',
  'constraints',
  'targetComplexity',
  'timeLimitMs',
  'memoryMb',
  'compareMode',
] as const;

export interface QuestionContent {
  title: string;
  statement: string;
  ioDescription: string;
  constraints: string;
  examples: Example[];
  targetComplexity: string;
  timeLimitMs: number;
  memoryMb: number;
  compareMode: (typeof COMPARE_MODES)[number];
}

/** True when changing from `before` to `after` leaves existing tests valid (only title/examples changed). */
export function testsStillValid(before: QuestionContent, after: QuestionContent): boolean {
  return TEST_AFFECTING_FIELDS.every((field) => before[field] === after[field]);
}

/** The listed keys of `source` that are not undefined. */
export function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}
