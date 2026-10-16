import { z } from 'zod';
import { COMPARE_MODES, FAIL_REASONS, LANGUAGES, VERDICTS } from './enums.js';

const nonEmpty = z.string().min(1);
const attempt = z.number().int().positive();
const questionNumber = z.number().int().positive();
const version = z.number().int().positive();

const answerRef = {
  examId: nonEmpty,
  studentEmail: nonEmpty,
  questionNumber,
  attempt,
};

/** Queue 1: API submit -> Transcribe Lambda. */
export const transcribeMsg = z.object({
  ...answerRef,
  questionId: nonEmpty,
  version,
});
export type TranscribeMsg = z.infer<typeof transcribeMsg>;

const limits = {
  timeLimitMs: z.number().int().positive(),
  memoryMb: z.number().int().positive(),
  compareMode: z.enum(COMPARE_MODES),
};

/**
 * Queue 2: Transcribe Lambda / question setup -> worker.
 * An ANSWER message carries the code and limits because the worker has no DynamoDB access.
 */
export const executeMsg = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ANSWER'),
    ...answerRef,
    questionId: nonEmpty,
    version,
    language: z.enum(LANGUAGES),
    correctedCode: nonEmpty,
    driverCode: nonEmpty,
    testsKey: nonEmpty,
    ...limits,
  }),
  z.object({
    type: z.literal('SETUP'),
    questionId: nonEmpty,
    version,
    /** Generation round: increments each time failed inputs are regenerated. */
    attempt,
    referenceKey: nonEmpty,
    generatorKey: nonEmpty,
    smallInputs: z.array(z.string()),
    largeInputCount: z.number().int().nonnegative(),
    ...limits,
  }),
]);
export type ExecuteMsg = z.infer<typeof executeMsg>;
export type ExecuteAnswerMsg = Extract<ExecuteMsg, { type: 'ANSWER' }>;
export type ExecuteSetupMsg = Extract<ExecuteMsg, { type: 'SETUP' }>;

export const testVerdictSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(['small', 'large']),
  verdict: z.enum(VERDICTS),
  input: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});

/** Queue 3: worker -> Record Lambda (answers) or question-setup handler (setup). */
// Two shapes share each `type`, so this is a plain union (narrow with `type` and `outcome`).
export const resultMsg = z.union([
  z.object({
    type: z.literal('ANSWER'),
    ...answerRef,
    outcome: z.literal('COMPLETED'),
    verdicts: z.array(testVerdictSchema),
  }),
  z.object({
    type: z.literal('ANSWER'),
    ...answerRef,
    outcome: z.literal('FAILED'),
    failReason: z.enum(FAIL_REASONS),
  }),
  z.object({
    type: z.literal('SETUP'),
    questionId: nonEmpty,
    version,
    attempt,
    outcome: z.literal('OK'),
    testsKey: nonEmpty,
    testCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('SETUP'),
    questionId: nonEmpty,
    version,
    attempt,
    outcome: z.literal('REFERENCE_FAILED'),
    /** Inputs on which the reference solution crashed or timed out; Gemini regenerates them. */
    failedInputIndexes: z.array(z.number().int().nonnegative()),
    reason: z.string(),
  }),
]);
export type ResultMsg = z.infer<typeof resultMsg>;

/** SQS FIFO ids: at most 128 characters. */
const MAX_FIFO_ID_LENGTH = 128;

function fifoId(parts: Array<string | number>): string {
  const value = parts.join('#');
  if (value.length > MAX_FIFO_ID_LENGTH) {
    throw new Error(`FIFO id is ${value.length} characters; SQS allows ${MAX_FIFO_ID_LENGTH}`);
  }
  return value;
}

/** MessageGroupId = exam + student, so one student's answers are processed in order. */
export function messageGroupId(examId: string, studentEmail: string): string {
  return fifoId([examId, studentEmail.toLowerCase()]);
}

/** MessageDeduplicationId = exam + student + question + attempt. */
export function messageDeduplicationId(
  examId: string,
  studentEmail: string,
  questionNumber: number,
  attempt: number,
): string {
  return fifoId([examId, studentEmail.toLowerCase(), questionNumber, attempt]);
}

/** Question-setup messages are not answer-specific; they group by question. */
export function setupGroupId(questionId: string): string {
  return fifoId(['setup', questionId]);
}

export function setupDeduplicationId(questionId: string, version: number, attempt: number): string {
  return fifoId(['setup', questionId, version, attempt]);
}
