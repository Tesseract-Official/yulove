import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type {
  AnswerItem,
  ExamItem,
  ExamStudentItem,
  QuestionItem,
  ResultMsg,
  TestVerdict,
} from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHandler } from './record.js';

const db = new FakeDb();
const lambda = mockClient(LambdaClient);

const EXAM = 'exam-1';
const EMAIL = 's1@college.edu';
const KEY = { examStudent: `${EXAM}#${EMAIL}`, questionNumber: 1 };

const exam: ExamItem = {
  examId: EXAM,
  batchId: 'A',
  title: 'Week 1',
  date: '2026-10-24',
  questions: [
    { number: 1, questionId: 'q1', version: 1, marks: 10 },
    { number: 2, questionId: 'q2', version: 1, marks: 5 },
  ],
  createdBy: 'teacher@college.edu',
  status: 'READY',
};

const answer = (extra: Partial<AnswerItem> = {}): AnswerItem => ({
  ...KEY,
  attempt: 1,
  status: 'RUNNING',
  imageKey: 'answers/exam-1/R1/q1.jpg',
  language: 'python',
  meetsComplexity: true,
  ...extra,
});
const stored = (n = 1) =>
  db.get<AnswerItem>('Answers', { examStudent: `${EXAM}#${EMAIL}`, questionNumber: n });
const totals = () => db.get<ExamStudentItem>('ExamStudents', { examId: EXAM, studentEmail: EMAIL });

const verdicts = (passed: number, total = 10, detail = false): TestVerdict[] =>
  Array.from({ length: total }, (_, index) => {
    const kind = index < 7 ? ('small' as const) : ('large' as const);
    if (index < passed) return { index, kind, verdict: 'AC' as const };
    return detail
      ? {
          index,
          kind,
          verdict: 'WA' as const,
          input: 'i'.repeat(300),
          expected: '1',
          actual: 'o'.repeat(300),
        }
      : { index, kind, verdict: 'WA' as const };
  });

const completed = (v: TestVerdict[], attempt = 1, questionNumber = 1): ResultMsg => ({
  type: 'ANSWER',
  examId: EXAM,
  studentEmail: EMAIL,
  questionNumber,
  attempt,
  outcome: 'COMPLETED',
  verdicts: v,
});
const answerFailed = (
  failReason: 'DRIVER_MISMATCH' | 'WORKER_ERROR',
  detail?: string,
  attempt = 1,
): ResultMsg => ({
  type: 'ANSWER',
  examId: EXAM,
  studentEmail: EMAIL,
  questionNumber: 1,
  attempt,
  outcome: 'FAILED',
  failReason,
  ...(detail ? { detail } : {}),
});

const event = (msg: ResultMsg | string) => ({
  Records: [{ body: typeof msg === 'string' ? msg : JSON.stringify(msg) }],
});
const invokes = () =>
  lambda
    .commandCalls(InvokeCommand)
    .map((c) => JSON.parse(new TextDecoder().decode(c.args[0].input.Payload as Uint8Array)));
const run = (msg: ResultMsg | string) => createHandler()(event(msg)).then(([o]) => o);

beforeEach(() => {
  db.reset();
  lambda.reset();
  lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
  process.env['TESTGEN_FUNCTION_NAME'] = 'testgen-fn';
  db.put('Exams', exam);
  db.put('Answers', answer());
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('an ANSWER result', () => {
  it('stores the verdicts, counts, score and sets GRADED', async () => {
    const outcome = await run(completed(verdicts(7)));

    expect(outcome).toEqual({ outcome: 'graded', score: 7 });
    expect(stored()).toMatchObject({
      status: 'GRADED',
      attempt: 1,
      testsPassed: 7,
      testsTotal: 10,
      score: 7,
    });
    expect(stored()?.verdicts).toHaveLength(10);
  });

  it('keeps input, expected and actual only for failed small tests, cut to 200 characters', async () => {
    await run(completed(verdicts(0, 10, true)));

    const kept = stored()?.verdicts ?? [];
    const small = kept.find((v) => v.index === 0);
    expect(small?.input).toHaveLength(200);
    expect(small?.actual).toHaveLength(200);
    expect(small?.expected).toBe('1');
    expect(kept.find((v) => v.index === 8)).toEqual({ index: 8, kind: 'large', verdict: 'WA' });
  });

  it('rounds the score to 2 decimal places', async () => {
    db.put('Exams', {
      ...exam,
      questions: [{ number: 1, questionId: 'q1', version: 1, marks: 3 }],
    });
    await run(completed(verdicts(7)));
    expect(stored()?.score).toBe(2.1);

    db.put('Answers', answer());
    db.put('Exams', {
      ...exam,
      questions: [{ number: 1, questionId: 'q1', version: 1, marks: 10 }],
    });
    await run(completed(verdicts(1, 3)));
    expect(stored()?.score).toBe(3.33);
  });

  it('gives full marks for all tests', async () => {
    expect(await run(completed(verdicts(10)))).toEqual({ outcome: 'graded', score: 10 });
  });

  it('gives 0 when the complexity target was missed, but keeps the verdicts', async () => {
    db.put('Answers', answer({ meetsComplexity: false }));

    expect(await run(completed(verdicts(10)))).toEqual({ outcome: 'graded', score: 0 });
    expect(stored()).toMatchObject({ status: 'GRADED', testsPassed: 10, score: 0 });
    expect(totals()).toMatchObject({ totalScore: 0, maxScore: 15 });
  });

  it('works out the exam total, with an override beating the formula score', async () => {
    db.put(
      'Answers',
      answer({ questionNumber: 2, status: 'GRADED', testsPassed: 10, testsTotal: 10 }),
    );
    await run(completed(verdicts(5)));
    expect(totals()).toEqual({
      examId: EXAM,
      studentEmail: EMAIL,
      absent: false,
      totalScore: 10, // 5 of 10 marks + 5 of 5
      maxScore: 15,
    });

    db.put(
      'Answers',
      answer({ attempt: 2, override: { score: 9, reason: 'r', by: 'a', at: 't' } }),
    );
    await run(completed(verdicts(0), 2));
    expect(totals()?.totalScore).toBe(14); // override 9 + 5
    expect(stored()).toMatchObject({ score: 0, override: { score: 9 } });
  });

  it('gives 0 for an absent student everywhere', async () => {
    db.put('ExamStudents', { examId: EXAM, studentEmail: EMAIL, absent: true });
    await run(completed(verdicts(10)));
    expect(stored()?.score).toBe(10); // the formula score is still stored
    expect(totals()).toMatchObject({ absent: true, totalScore: 0, maxScore: 15 });
  });

  describe('a worker failure', () => {
    it.each([
      ['DRIVER_MISMATCH', 'The driver program changed the student code'],
      ['WORKER_ERROR', 'sandbox crashed'],
    ] as const)('%s: FAILED_TO_GRADE with the reason and detail', async (reason, detail) => {
      expect(await run(answerFailed(reason, detail))).toEqual({
        outcome: 'failed-to-grade',
        failReason: reason,
      });
      expect(stored()).toMatchObject({
        status: 'FAILED_TO_GRADE',
        failReason: reason,
        failDetail: detail,
      });
      expect(totals()).toMatchObject({ totalScore: 0 });
    });

    it('counts one FailedToGrade metric for the failure', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await run(answerFailed('WORKER_ERROR', 'sandbox crashed'));
      const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
      expect(lines).toEqual([
        expect.objectContaining({ FailedToGrade: 1, reason: 'WORKER_ERROR' }),
      ]);
      log.mockRestore();
    });

    it('works without a detail', async () => {
      await run(answerFailed('WORKER_ERROR'));
      expect(stored()).toMatchObject({ status: 'FAILED_TO_GRADE', failReason: 'WORKER_ERROR' });
      expect(stored()).not.toHaveProperty('failDetail');
    });
  });

  describe('stale and duplicate results', () => {
    it('counts no FailedToGrade metric when a failure arrives for an older attempt', async () => {
      db.put('Answers', answer({ attempt: 2, status: 'RUNNING' }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await run(answerFailed('WORKER_ERROR', 'late', 1))).toEqual({ outcome: 'stale' });
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('ignores a result for an older attempt and writes nothing', async () => {
      db.put('Answers', answer({ attempt: 2, status: 'RUNNING' }));

      expect(await run(completed(verdicts(10), 1))).toEqual({ outcome: 'stale' });
      expect(stored()).toMatchObject({ attempt: 2, status: 'RUNNING' });
      expect(stored()).not.toHaveProperty('score');
      expect(totals()).toBeUndefined();
    });

    it('ignores a result for an attempt that has not happened', async () => {
      expect(await run(completed(verdicts(10), 5))).toEqual({ outcome: 'stale' });
      expect(stored()?.status).toBe('RUNNING');
    });

    it('ignores a second copy of a result that is already recorded', async () => {
      await run(completed(verdicts(7)));
      const first = stored();

      expect(await run(completed(verdicts(2)))).toEqual({ outcome: 'duplicate' });
      expect(stored()).toEqual(first);
      expect(stored()?.testsPassed).toBe(7);
    });

    it('ignores a result for an answer already failed in this attempt', async () => {
      db.put('Answers', answer({ status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE' }));
      expect(await run(completed(verdicts(10)))).toEqual({ outcome: 'duplicate' });
      expect(stored()?.status).toBe('FAILED_TO_GRADE');
    });

    it('ignores a result for an answer that is not there', async () => {
      db.reset();
      db.put('Exams', exam);
      expect(await run(completed(verdicts(10)))).toMatchObject({ outcome: 'ignored' });
      expect(db.all('Answers')).toHaveLength(0);
    });
  });

  describe('a re-run', () => {
    it("replaces the old score with the new attempt's", async () => {
      await run(completed(verdicts(3)));
      expect(stored()).toMatchObject({ attempt: 1, score: 3, status: 'GRADED' });

      // The batch manager re-runs: attempt 2 is queued, transcribed, executed.
      db.put('Answers', { ...stored()!, attempt: 2, status: 'RUNNING' });
      await run(completed(verdicts(9), 2));

      expect(stored()).toMatchObject({ attempt: 2, status: 'GRADED', testsPassed: 9, score: 9 });
      expect(totals()?.totalScore).toBe(9);
    });

    it('a late result of the first attempt cannot undo it', async () => {
      await run(completed(verdicts(9)));
      db.put('Answers', { ...stored()!, attempt: 2, status: 'RUNNING' });
      await run(completed(verdicts(4), 2));

      expect(await run(completed(verdicts(0), 1))).toEqual({ outcome: 'stale' });
      expect(stored()).toMatchObject({ attempt: 2, score: 4 });
    });
  });

  describe('when something unexpected goes wrong', () => {
    it('never throws, logs, and ends the answer as failed to grade', async () => {
      db.put('Exams', {
        ...exam,
        questions: [{ number: 2, questionId: 'q2', version: 1, marks: 5 }],
      });
      const [outcome] = await createHandler()(event(completed(verdicts(10))));
      expect(outcome).toMatchObject({ outcome: 'ignored', reason: 'question not in exam' });
      expect(stored()).toMatchObject({ status: 'FAILED_TO_GRADE', failReason: 'WORKER_ERROR' });
    });

    it('survives a database error and leaves nothing RUNNING', async () => {
      process.env['EXAMS_TABLE'] = 'no-such-table';
      const [outcome] = await createHandler()(event(completed(verdicts(10))));
      process.env['EXAMS_TABLE'] = 'Exams';

      expect(outcome).toMatchObject({ outcome: 'error' });
      expect(stored()).toMatchObject({
        status: 'FAILED_TO_GRADE',
        failReason: 'WORKER_ERROR',
        failDetail: 'Could not record the result, re-run',
      });
    });

    it('keeps the recorded answer even if the total cannot be updated', async () => {
      process.env['EXAM_STUDENTS_TABLE'] = 'no-such-table';
      const [outcome] = await createHandler()(event(completed(verdicts(7))));
      process.env['EXAM_STUDENTS_TABLE'] = 'ExamStudents';

      expect(outcome).toEqual({ outcome: 'graded', score: 7 });
      expect(stored()?.status).toBe('GRADED');
    });

    it.each(['not json', '{}', JSON.stringify({ type: 'ANSWER' })])(
      'drops an unreadable message (%s)',
      async (body) => {
        expect(await run(body)).toEqual({ outcome: 'ignored', reason: 'unreadable message' });
        expect(stored()?.status).toBe('RUNNING');
      },
    );

    it('handles every record in a batch', async () => {
      db.put('Answers', answer({ questionNumber: 2 }));
      const handler = createHandler();
      const outcomes = await handler({
        Records: [
          { body: JSON.stringify(completed(verdicts(10), 1, 1)) },
          { body: 'junk' },
          { body: JSON.stringify(completed(verdicts(5), 1, 2)) },
        ],
      });
      expect(outcomes.map((o) => o.outcome)).toEqual(['graded', 'ignored', 'graded']);
    });
  });
});

describe('a SETUP result', () => {
  const question = (extra: Partial<QuestionItem> = {}): QuestionItem => ({
    questionId: 'q1',
    version: 1,
    teacherEmail: 'teacher@college.edu',
    title: 'T',
    statement: 'S',
    ioDescription: 'IO',
    constraints: 'C',
    examples: [{ input: '{}', output: '1' }],
    targetComplexity: 'O(n)',
    timeLimitMs: 1000,
    memoryMb: 256,
    compareMode: 'EXACT',
    testStatus: 'GENERATING',
    testAttempt: 2,
    testRegenerations: 0,
    ...extra,
  });
  const q = () => db.get<QuestionItem>('Questions', { questionId: 'q1', version: 1 });
  const setupOk: ResultMsg = {
    type: 'SETUP',
    questionId: 'q1',
    version: 1,
    attempt: 2,
    outcome: 'OK',
    testsKey: 'questions/q1/v1/tests.json',
    testCount: 10,
  };
  const referenceFailed = (indexes: number[], attempt = 2): ResultMsg => ({
    type: 'SETUP',
    questionId: 'q1',
    version: 1,
    attempt,
    outcome: 'REFERENCE_FAILED',
    failedInputIndexes: indexes,
    reason: 'The reference solution timed out on input 8',
  });

  beforeEach(() => {
    db.put('Questions', question());
  });

  it('OK: stores the test count and file and moves to NEEDS_REVIEW', async () => {
    expect(await run(setupOk)).toEqual({ outcome: 'tests-ready' });
    expect(q()).toMatchObject({
      testStatus: 'NEEDS_REVIEW',
      testCount: 10,
      testsKey: 'questions/q1/v1/tests.json',
    });
    expect(invokes()).toHaveLength(0);
  });

  it('OK twice: the second is a duplicate and changes nothing', async () => {
    await run(setupOk);
    expect(await run({ ...setupOk, testCount: 9 } as ResultMsg)).toEqual({ outcome: 'duplicate' });
    expect(q()?.testCount).toBe(10);
  });

  it('OK for an old round is ignored', async () => {
    expect(await run({ ...setupOk, attempt: 1 } as ResultMsg)).toEqual({ outcome: 'stale' });
    expect(q()?.testStatus).toBe('GENERATING');
  });

  it('OK for a question that was approved already does not change it', async () => {
    await run(setupOk);
    db.put('Questions', { ...q()!, testStatus: 'APPROVED' });
    expect(await run(setupOk)).toEqual({ outcome: 'duplicate' });
    expect(q()?.testStatus).toBe('APPROVED');
  });

  it('REFERENCE_FAILED: asks the test-generation Lambda to replace exactly those inputs', async () => {
    expect(await run(referenceFailed([3, 8]))).toEqual({
      outcome: 'regenerating',
      indexes: [3, 8],
    });

    expect(invokes()).toEqual([
      {
        mode: 'regenerate',
        questionId: 'q1',
        version: 1,
        attempt: 2,
        indexes: [3, 8],
        reason: 'The reference solution timed out on input 8',
      },
    ]);
    const call = lambda.commandCalls(InvokeCommand)[0]?.args[0].input;
    expect(call).toMatchObject({ FunctionName: 'testgen-fn', InvocationType: 'Event' });
    expect(q()?.testStatus).toBe('GENERATING');
  });

  it('REFERENCE_FAILED again after the first replacement round: still asks', async () => {
    db.put('Questions', question({ testRegenerations: 1, testAttempt: 3 }));
    expect(await run(referenceFailed([1], 3))).toMatchObject({ outcome: 'regenerating' });
    expect(invokes()).toHaveLength(1);
    expect(q()?.testStatus).toBe('GENERATING');
  });

  it('REFERENCE_FAILED after 2 replacement rounds: GENERATION_FAILED, no more asking', async () => {
    db.put('Questions', question({ testRegenerations: 2, testAttempt: 4 }));

    const outcome = await run(referenceFailed([5], 4));

    expect(outcome).toMatchObject({ outcome: 'generation-failed' });
    expect(invokes()).toHaveLength(0);
    expect(q()).toMatchObject({ testStatus: 'GENERATION_FAILED' });
    expect(q()?.testFailure).toMatch(/still failed after 2 rounds/);
    expect(q()?.testFailure).toMatch(/timed out on input 8/);
    expect(q()?.testFailure?.length).toBeLessThanOrEqual(300);
  });

  it('runs through both replacement rounds as the pipeline would, ending in GENERATION_FAILED', async () => {
    await run(referenceFailed([2], 2)); // round 0 -> asks
    db.put('Questions', question({ testRegenerations: 1, testAttempt: 3 }));
    await run(referenceFailed([2], 3)); // round 1 -> asks
    db.put('Questions', question({ testRegenerations: 2, testAttempt: 4 }));
    const last = await run(referenceFailed([2], 4)); // round 2 -> gives up

    expect(invokes()).toHaveLength(2);
    expect(last).toMatchObject({ outcome: 'generation-failed' });
    expect(q()?.testStatus).toBe('GENERATION_FAILED');
  });

  it('REFERENCE_FAILED for an old round is ignored', async () => {
    expect(await run(referenceFailed([1], 1))).toEqual({ outcome: 'stale' });
    expect(invokes()).toHaveLength(0);
  });

  it('REFERENCE_FAILED when the question is no longer generating does nothing', async () => {
    db.put('Questions', question({ testStatus: 'GENERATION_FAILED' }));
    expect(await run(referenceFailed([1]))).toEqual({ outcome: 'duplicate' });
    expect(invokes()).toHaveLength(0);
  });

  it('fails the round if the Lambda cannot be invoked', async () => {
    lambda.on(InvokeCommand).rejects(new Error('AccessDenied'));
    const outcome = await run(referenceFailed([1]));
    expect(outcome).toMatchObject({ outcome: 'generation-failed' });
    expect(q()?.testStatus).toBe('GENERATION_FAILED');
    expect(q()?.testFailure).toMatch(/Could not ask for replacement inputs: AccessDenied/);
  });

  it("FAILED: GENERATION_FAILED with the worker's reason", async () => {
    const outcome = await run({
      type: 'SETUP',
      questionId: 'q1',
      version: 1,
      attempt: 2,
      outcome: 'FAILED',
      reason: 'Could not read reference.py from storage',
    });

    expect(outcome).toMatchObject({ outcome: 'generation-failed' });
    expect(q()).toMatchObject({ testStatus: 'GENERATION_FAILED' });
    expect(q()?.testFailure).toBe('Setup failed: Could not read reference.py from storage');
    expect(invokes()).toHaveLength(0);
  });

  it('FAILED for an old round is ignored', async () => {
    expect(
      await run({
        type: 'SETUP',
        questionId: 'q1',
        version: 1,
        attempt: 1,
        outcome: 'FAILED',
        reason: 'x',
      }),
    ).toEqual({ outcome: 'stale' });
    expect(q()?.testStatus).toBe('GENERATING');
  });

  it('ignores a question that does not exist, and survives database errors', async () => {
    expect(await run({ ...setupOk, questionId: 'nope' } as ResultMsg)).toMatchObject({
      outcome: 'ignored',
    });

    process.env['QUESTIONS_TABLE'] = 'no-such-table';
    const [outcome] = await createHandler()(event(setupOk));
    process.env['QUESTIONS_TABLE'] = 'Questions';
    expect(outcome).toMatchObject({ outcome: 'error' });
  });
});

describe('the AppError metric', () => {
  const appErrors = (log: MockInstance<typeof console.log>) =>
    log.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['AppError'] === 1);

  let log: MockInstance<typeof console.log>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('counts a result that could not be recorded because of a database error', async () => {
    process.env['EXAMS_TABLE'] = 'no-such-table';
    await run(completed(verdicts(10)));
    process.env['EXAMS_TABLE'] = 'Exams';
    expect(appErrors(log)).toEqual([expect.objectContaining({ source: 'record' })]);
  });

  it('counts a total that could not be updated', async () => {
    process.env['EXAM_STUDENTS_TABLE'] = 'no-such-table';
    await run(completed(verdicts(7)));
    process.env['EXAM_STUDENTS_TABLE'] = 'ExamStudents';
    expect(appErrors(log)).toHaveLength(1);
  });

  it('counts a message that cannot be read', async () => {
    await run('not json');
    expect(appErrors(log)).toHaveLength(1);
  });

  it.each([
    ['a graded answer', () => completed(verdicts(10))],
    [
      'a worker failure the worker reported (FAILED_TO_GRADE)',
      () => answerFailed('WORKER_ERROR', 'sandbox crashed'),
    ],
    ['a worker driver mismatch', () => answerFailed('DRIVER_MISMATCH')],
  ])('does not count %s', async (_name, message) => {
    await run(message());
    expect(appErrors(log)).toEqual([]);
  });

  it('does not count a stale result', async () => {
    db.put('Answers', answer({ attempt: 2, status: 'RUNNING' }));
    await run(completed(verdicts(10), 1));
    expect(appErrors(log)).toEqual([]);
  });
});
