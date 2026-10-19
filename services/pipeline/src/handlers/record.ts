import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  emitAppError,
  computeRawScore,
  countPassed,
  resultMsg,
  storedVerdicts,
  TESTGEN_FUNCTION_ENV,
  type ResultMsg,
} from '@yulove/shared';
import { answersDb, examsDb, questionsDb, recomputeExamTotal } from '@yulove/shared/server';
import { requireEnv } from '../lib/secret.js';
import { MAX_REGENERATION_ROUNDS } from './generate-tests.js';

type AnswerResult = Extract<ResultMsg, { type: 'ANSWER' }>;
type SetupResult = Extract<ResultMsg, { type: 'SETUP' }>;

export type RecordOutcome =
  | { outcome: 'graded'; score: number }
  | { outcome: 'failed-to-grade'; failReason: string }
  | { outcome: 'tests-ready' }
  | { outcome: 'regenerating'; indexes: number[] }
  | { outcome: 'generation-failed'; reason: string }
  /** An older attempt or round than the one stored: nothing is written. */
  | { outcome: 'stale' }
  /** This attempt or round was already recorded: nothing is written. */
  | { outcome: 'duplicate' }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'error'; reason: string };

export interface Deps {
  /** Starts the test-generation Lambda in regenerate mode (asynchronously). */
  invokeRegenerate(event: Record<string, unknown>): Promise<void>;
}

const defaultDeps: Deps = {
  async invokeRegenerate(event) {
    const out = await new LambdaClient({}).send(
      new InvokeCommand({
        FunctionName: requireEnv(TESTGEN_FUNCTION_ENV),
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify(event)),
      }),
    );
    if (out.StatusCode !== 202) throw new Error(`Lambda invoke returned ${String(out.StatusCode)}`);
  },
};

const cut = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The answer is RUNNING for this attempt: write the worker's verdicts or its failure. */
async function recordAnswer(msg: AnswerResult): Promise<RecordOutcome> {
  const key = {
    examId: msg.examId,
    studentEmail: msg.studentEmail,
    questionNumber: msg.questionNumber,
  };
  const answer = await answersDb.getAnswer(key);
  if (!answer) return { outcome: 'ignored', reason: 'no such answer' };
  if (answer.attempt !== msg.attempt) return { outcome: 'stale' };
  // The first result for an attempt moves it out of RUNNING; a second copy finds it already done.
  if (answer.status !== 'RUNNING') return { outcome: 'duplicate' };

  const exam = await examsDb.getExam(msg.examId);
  if (!exam) {
    await answersDb.markFailed(key, msg.attempt, 'WORKER_ERROR', 'The exam no longer exists.');
    return { outcome: 'ignored', reason: 'exam not found' };
  }

  let outcome: RecordOutcome;
  if (msg.outcome === 'FAILED') {
    const written = await answersDb.markFailed(key, msg.attempt, msg.failReason, msg.detail);
    if (written === 'stale') return { outcome: 'stale' };
    outcome = { outcome: 'failed-to-grade', failReason: msg.failReason };
  } else {
    const ref = exam.questions.find((q) => q.number === msg.questionNumber);
    if (!ref) {
      await answersDb.markFailed(
        key,
        msg.attempt,
        'WORKER_ERROR',
        'The exam has no such question.',
      );
      return { outcome: 'ignored', reason: 'question not in exam' };
    }
    const testsPassed = countPassed(msg.verdicts);
    const testsTotal = msg.verdicts.length;
    // The formula score only; an override is applied when the total is worked out.
    const score = computeRawScore(ref.marks, {
      status: 'GRADED',
      testsPassed,
      testsTotal,
      ...(answer.meetsComplexity !== undefined ? { meetsComplexity: answer.meetsComplexity } : {}),
    });
    const written = await answersDb.recordAnswerResult(key, msg.attempt, {
      testsPassed,
      testsTotal,
      verdicts: storedVerdicts(msg.verdicts),
      score,
    });
    if (written === 'stale') return { outcome: 'stale' };
    outcome = { outcome: 'graded', score };
  }

  try {
    await recomputeExamTotal(exam, msg.studentEmail);
  } catch (error) {
    // The answer is recorded; the total is also recomputed by publishing and by absences.
    console.error('Could not update the exam total', error);
    emitAppError('record');
  }
  return outcome;
}

async function recordSetup(msg: SetupResult, deps: Deps): Promise<RecordOutcome> {
  const question = await questionsDb.getQuestion(msg.questionId, msg.version);
  if (!question) return { outcome: 'ignored', reason: 'no such question' };
  if (question.testAttempt !== msg.attempt) return { outcome: 'stale' };

  const fail = async (reason: string): Promise<RecordOutcome> => {
    const text = cut(reason);
    const written = await questionsDb.markGenerationFailed(
      msg.questionId,
      msg.version,
      msg.attempt,
      text,
    );
    return written === 'stale'
      ? { outcome: 'stale' }
      : { outcome: 'generation-failed', reason: text };
  };

  if (msg.outcome === 'OK') {
    const written = await questionsDb.saveTestsReady(msg.questionId, msg.version, msg.attempt, {
      testsKey: msg.testsKey,
      testCount: msg.testCount,
    });
    return written === 'stale' ? { outcome: 'duplicate' } : { outcome: 'tests-ready' };
  }

  if (msg.outcome === 'FAILED') return fail(`Setup failed: ${msg.reason}`);

  // Some inputs made the reference solution crash or time out: have Gemini replace them, twice at most.
  if (question.testStatus !== 'GENERATING') return { outcome: 'duplicate' };
  if ((question.testRegenerations ?? 0) >= MAX_REGENERATION_ROUNDS) {
    return fail(
      `The reference solution still failed after ${MAX_REGENERATION_ROUNDS} rounds of replacing inputs: ${msg.reason}`,
    );
  }
  if (msg.failedInputIndexes.length === 0) {
    return fail(`The reference solution failed but no input was named: ${msg.reason}`);
  }
  try {
    await deps.invokeRegenerate({
      mode: 'regenerate',
      questionId: msg.questionId,
      version: msg.version,
      attempt: msg.attempt,
      indexes: msg.failedInputIndexes,
      reason: msg.reason,
    });
  } catch (error) {
    return fail(`Could not ask for replacement inputs: ${reasonOf(error)}`);
  }
  return { outcome: 'regenerating', indexes: msg.failedInputIndexes };
}

/** When something unexpected goes wrong, end the answer or the round rather than leave it hanging. */
async function giveUp(msg: ResultMsg, error: unknown): Promise<void> {
  try {
    if (msg.type === 'ANSWER') {
      await answersDb.markFailed(
        {
          examId: msg.examId,
          studentEmail: msg.studentEmail,
          questionNumber: msg.questionNumber,
        },
        msg.attempt,
        'WORKER_ERROR',
        'Could not record the result. Press Grade again.',
      );
    } else {
      await questionsDb.markGenerationFailed(
        msg.questionId,
        msg.version,
        msg.attempt,
        cut(`Could not process the setup result: ${reasonOf(error)}`),
      );
    }
  } catch (second) {
    console.error('Could not even record the failure', second);
    emitAppError('record');
  }
}

export interface SqsRecordEvent {
  Records: Array<{ body: string }>;
}

/**
 * The Record Lambda (SQS trigger on the results queue, batch size 1). It never throws: a result
 * that cannot be recorded is logged and the answer or question is ended as failed, because a FIFO
 * queue with no dead-letter queue would otherwise retry it for ever. Results for an older attempt
 * or round, and second copies of a result already recorded, change nothing.
 */
export function createHandler(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps, ...overrides };

  return async function handler(event: SqsRecordEvent): Promise<RecordOutcome[]> {
    const outcomes: RecordOutcome[] = [];
    for (const record of event.Records) {
      let msg: ResultMsg;
      try {
        msg = resultMsg.parse(JSON.parse(record.body));
      } catch {
        console.error('Ignoring an unreadable result message');
        emitAppError('record');
        outcomes.push({ outcome: 'ignored', reason: 'unreadable message' });
        continue;
      }

      try {
        outcomes.push(
          msg.type === 'ANSWER' ? await recordAnswer(msg) : await recordSetup(msg, deps),
        );
      } catch (error) {
        console.error(`Could not record a ${msg.type} result`, error);
        emitAppError('record');
        await giveUp(msg, error);
        outcomes.push({ outcome: 'error', reason: reasonOf(error) });
      }
    }
    return outcomes;
  };
}

export const handler = createHandler();
