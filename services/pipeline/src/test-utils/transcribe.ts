import type { QuestionItem } from '@yulove/shared';
import type { GeminiClient, GenerateJsonRequest } from '../lib/gemini.js';

export const CODE = 'def solve(nums):\n    return sum(nums)';
export const DRIVER = `import json\nimport sys\n\n${CODE}\n\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`;

/** A reply Gemini could plausibly give for a good page. */
export const goodReply = (change: Record<string, unknown> = {}) =>
  JSON.stringify({
    readable: true,
    language: 'python',
    rawTranscription: 'def solve(nums)\n return sum(nums)',
    correctedCode: CODE,
    fixes: ['Added the missing colon', 'Restored the indentation'],
    estimatedComplexity: 'O(n)',
    meetsComplexity: true,
    driverCode: DRIVER,
    ...change,
  });

export const question: QuestionItem = {
  questionId: 'q1',
  version: 1,
  teacherEmail: 't@college.edu',
  title: 'Sum of numbers',
  statement: 'Return the sum of the list.',
  ioDescription: 'Input: nums. Output: the sum.',
  constraints: '1 <= n <= 1000',
  examples: [],
  signature: { name: 'solve', parameters: [{ name: 'nums', type: 'int[]' }], returnType: 'int' },
  targetComplexity: 'O(n)',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
  testStatus: 'APPROVED',
  testAttempt: 1,
};

/** A scripted Gemini: returns the next reply, or throws it if it is an Error. */
export class Scripted implements GeminiClient {
  readonly requests: GenerateJsonRequest[] = [];
  constructor(private readonly replies: Array<string | Error>) {}
  async generateJson(request: GenerateJsonRequest) {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error('The fake Gemini has no reply left');
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

export const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
