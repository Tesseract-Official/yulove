import type { TestVerdict } from './types.js';

/** Failed small tests keep their input, expected output and the student's output cut to this. */
export const VERDICT_TEXT_LIMIT = 200;

const cut = (text: string) =>
  text.length > VERDICT_TEXT_LIMIT ? `${text.slice(0, VERDICT_TEXT_LIMIT - 3)}...` : text;

/**
 * The verdicts as stored on an answer: every test keeps its index, kind and verdict; only a
 * failed small test also keeps its input, expected and actual output, each cut to 200
 * characters. Large tests keep only the verdict, whatever the worker sent.
 */
export function storedVerdicts(verdicts: readonly TestVerdict[]): TestVerdict[] {
  return verdicts.map((v) => {
    const kept: TestVerdict = { index: v.index, kind: v.kind, verdict: v.verdict };
    if (v.kind === 'small' && v.verdict !== 'AC') {
      if (v.input !== undefined) kept.input = cut(v.input);
      if (v.expected !== undefined) kept.expected = cut(v.expected);
      if (v.actual !== undefined) kept.actual = cut(v.actual);
    }
    return kept;
  });
}

/** Tests with an AC verdict. */
export function countPassed(verdicts: readonly Pick<TestVerdict, 'verdict'>[]): number {
  return verdicts.filter((v) => v.verdict === 'AC').length;
}
