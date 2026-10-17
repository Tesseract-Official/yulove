import { describe, expect, it } from 'vitest';
import { answerImageKey, driverContainsCode, UPLOAD_URL_SECONDS } from './answer-files.js';

interface WorkerJudge {
  containsUnchanged(program: string, correctedCode: string): boolean;
}
const judgeUrl = new URL('../../../worker/src/judge.js', import.meta.url).href;
const worker = (await import(/* @vite-ignore */ judgeUrl)) as WorkerJudge;

describe('answerImageKey', () => {
  it('is answers/{examId}/{rollNo}/q{n}.jpg', () => {
    expect(answerImageKey('exam-1', '22CS101', 3)).toBe('answers/exam-1/22CS101/q3.jpg');
  });

  it('keeps a roll number with odd characters inside its own folder', () => {
    expect(answerImageKey('exam-1', '../x/22 CS#1', 1)).toBe(
      'answers/exam-1/..%2Fx%2F22%20CS%231/q1.jpg',
    );
    expect(answerImageKey('exam-1', '../x/22 CS#1', 1).split('/')).toHaveLength(4);
  });

  it('lasts ten minutes', () => {
    expect(UPLOAD_URL_SECONDS).toBe(600);
  });
});

const CODE = 'def solve(nums):\n    return sum(nums)';
const CASES: Array<[string, string, string]> = [
  ['contained exactly', `import json\n\n${CODE}\n\nprint(1)\n`, CODE],
  ['windows line endings in the driver', `x\r\n${CODE.replace(/\n/g, '\r\n')}\r\ny`, CODE],
  ['windows line endings in the code', `x\n${CODE}\ny`, CODE.replace(/\n/g, '\r\n')],
  ['blank space around the code', `x\n${CODE}\ny`, `\n\n  ${CODE}  \n\n`],
  ['a changed operator', `x\n${CODE.replace('sum', 'max')}\ny`, CODE],
  ['changed indentation', `x\n${CODE.replace('    return', '  return')}\ny`, CODE],
  ['a missing line', 'def solve(nums):\n', CODE],
  ['empty code', 'anything', ''],
  ['blank code', 'anything', '  \n '],
  ['code only', CODE, CODE],
];

describe('driverContainsCode', () => {
  it.each(CASES)('%s', (_name, driver, code) => {
    expect(driverContainsCode(driver, code)).toBe(worker.containsUnchanged(driver, code));
  });

  it('accepts and rejects what it should', () => {
    expect(driverContainsCode(`import json\n\n${CODE}\n`, CODE)).toBe(true);
    expect(driverContainsCode(`import json\n${CODE.replace('sum', 'max')}\n`, CODE)).toBe(false);
    expect(driverContainsCode('anything', '')).toBe(false);
  });
});
