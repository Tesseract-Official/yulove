import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { transcribeMsg, type AnswerItem, type ExamItem, type QuestionItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveDirectly,
  BATCH_ID,
  describeAnswer,
  describeTests,
  ensureDevData,
  ensureExam,
  ensureTests,
  EXAM_ID,
  GenerationFailedError,
  PHOTOS,
  pollUntil,
  readTotals,
  STUDENT_EMAIL,
  STUDENT_ROLL,
  submitPhoto,
  waitForAnswers,
  type Aws,
  type Clock,
} from './e2e-pipeline.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const lambda = mockClient(LambdaClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));

const aws: Aws = {
  bucket: 'bucket',
  transcribeQueueUrl: 'https://sqs.example/transcribe.fifo',
  testgenFunction: 'testgen-fn',
  s3: new S3Client({ region: 'ap-south-1' }),
  sqs: new SQSClient({ region: 'ap-south-1' }),
  lambda: new LambdaClient({ region: 'ap-south-1' }),
};

/** A clock whose sleeps move time on, so polling loops end at once. */
function fakeClock(onSleep?: () => void): Clock & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
      onSleep?.();
    },
  };
}

const notFound = () => Object.assign(new Error('nf'), { name: 'NotFound' });
const tests = (id: string) =>
  JSON.stringify({
    questionId: id,
    version: 1,
    tests: Array.from({ length: 10 }, (_, index) => ({
      index,
      kind: index < 7 ? 'small' : 'large',
      input: `{"x":${index}}`,
      expected: `${index}`,
    })),
  });
const question = (id: string) =>
  db.get<QuestionItem>('Questions', { questionId: id, version: 1 }) as QuestionItem;
const answer = (n: number) =>
  db.get<AnswerItem>('Answers', { examStudent: `${EXAM_ID}#${STUDENT_EMAIL}`, questionNumber: n });

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  lambda.reset();
  lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
  sqs.on(SendMessageCommand).resolves({});
  s3.on(PutObjectCommand).resolves({});
});

describe('ensureDevData', () => {
  it('adds the batch, the student and both questions, all marked dev', async () => {
    const lines: string[] = [];
    await ensureDevData(client, (l) => lines.push(l));

    expect(db.batches.get(BATCH_ID)).toEqual({ batchId: BATCH_ID, name: 'Dev batch', dev: true });
    expect(db.users.get(STUDENT_EMAIL)).toEqual({
      email: STUDENT_EMAIL,
      role: 'STUDENT',
      name: 'Dev Student',
      rollNo: 'DEV001',
      batchId: 'dev-batch',
      active: true,
      dev: true,
    });
    expect(question('dev-sum-array')).toMatchObject({ dev: true, title: 'Sum of array' });
    expect(question('dev-reverse-string')).toMatchObject({ dev: true });
    expect(lines.filter((l) => l.startsWith('Added'))).toHaveLength(4);
  });

  it('is safe to run again: nothing is overwritten', async () => {
    await ensureDevData(client, () => undefined);
    db.put('Questions', { ...question('dev-sum-array'), title: 'Edited by hand' });
    db.addUser({ ...db.users.get(STUDENT_EMAIL)!, name: 'Renamed' });

    const lines: string[] = [];
    await ensureDevData(client, (l) => lines.push(l));

    expect(question('dev-sum-array').title).toBe('Edited by hand');
    expect(db.users.get(STUDENT_EMAIL)?.name).toBe('Renamed');
    expect(lines.every((l) => l.includes('already there'))).toBe(true);
  });
});

describe('ensureExam', () => {
  it('creates dev-exam READY with both questions at 5 marks, and the student row', async () => {
    await ensureExam(() => undefined, '2026-10-17');

    const exam = db.get<ExamItem>('Exams', { examId: EXAM_ID })!;
    expect(exam).toMatchObject({
      examId: 'dev-exam',
      batchId: 'dev-batch',
      status: 'READY',
      dev: true,
      date: '2026-10-17',
    });
    expect(exam.questions).toEqual([
      { number: 1, questionId: 'dev-sum-array', version: 1, marks: 5 },
      { number: 2, questionId: 'dev-reverse-string', version: 1, marks: 5 },
    ]);
    expect(db.get('ExamStudents', { examId: EXAM_ID, studentEmail: STUDENT_EMAIL })).toEqual({
      examId: EXAM_ID,
      studentEmail: STUDENT_EMAIL,
      absent: false,
      dev: true,
    });
  });

  it('leaves an existing exam and row alone', async () => {
    await ensureExam(() => undefined, '2026-10-17');
    db.put('Exams', { ...db.get<ExamItem>('Exams', { examId: EXAM_ID })!, status: 'PUBLISHED' });
    db.put('ExamStudents', {
      examId: EXAM_ID,
      studentEmail: STUDENT_EMAIL,
      absent: true,
      totalScore: 4,
    });

    const exam = await ensureExam(() => undefined, '2030-01-01');

    expect(exam).toMatchObject({ status: 'PUBLISHED', date: '2026-10-17' });
    expect(db.get('ExamStudents', { examId: EXAM_ID, studentEmail: STUDENT_EMAIL })).toMatchObject({
      absent: true,
      totalScore: 4,
    });
  });
});

describe('ensureTests', () => {
  const ids = ['dev-sum-array', 'dev-reverse-string'];
  beforeEach(async () => {
    await ensureDevData(client, () => undefined);
  });

  it('leaves questions that already have tests alone, and approves them', async () => {
    db.put('Questions', { ...question('dev-sum-array'), testStatus: 'NEEDS_REVIEW' });
    s3.on(HeadObjectCommand).resolves({});
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) => ({
      Body: { transformToString: async () => tests(input.Key.split('/')[1] as string) } as never,
    }));

    const outcomes = await ensureTests(aws, ids, fakeClock(), () => undefined);

    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(outcomes.map((o) => o.how)).toEqual(['existing', 'existing']);
    expect(question('dev-sum-array').testStatus).toBe('APPROVED');
    expect(outcomes[0]?.tests.tests).toHaveLength(10);
  });

  it('generates the ones without tests, waits for NEEDS_REVIEW, prints them and approves', async () => {
    s3.on(HeadObjectCommand).rejects(notFound());
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) => ({
      Body: { transformToString: async () => tests(input.Key.split('/')[1] as string) } as never,
    }));
    const clock = fakeClock(() => {
      // The pipeline finishes while the script waits.
      for (const id of ids) {
        db.put('Questions', { ...question(id), testStatus: 'NEEDS_REVIEW', testCount: 10 });
      }
    });
    const lines: string[] = [];

    const outcomes = await ensureTests(aws, ids, clock, (l) => lines.push(l));

    const events = lambda
      .commandCalls(InvokeCommand)
      .map((c) => JSON.parse(new TextDecoder().decode(c.args[0].input.Payload as Uint8Array)));
    expect(events).toEqual([
      { mode: 'generate', questionId: 'dev-sum-array', version: 1, attempt: 2 },
      { mode: 'generate', questionId: 'dev-reverse-string', version: 1, attempt: 2 },
    ]);
    expect(lambda.commandCalls(InvokeCommand)[0]?.args[0].input.FunctionName).toBe('testgen-fn');
    expect(outcomes.map((o) => o.how)).toEqual(['generated', 'generated']);
    expect(ids.map((id) => question(id).testStatus)).toEqual(['APPROVED', 'APPROVED']);
    expect(question('dev-sum-array')).toMatchObject({
      testsKey: 'questions/dev-sum-array/v1/tests.json',
      testCount: 10,
    });
    expect(lines.join('\n')).toMatch(/dev-sum-array: GENERATING/);
    expect(lines.join('\n')).toMatch(/dev-sum-array: NEEDS_REVIEW/);
  });

  it('stops with the reason when generation fails', async () => {
    s3.on(HeadObjectCommand).rejects(notFound());
    const clock = fakeClock(() => {
      db.put('Questions', {
        ...question('dev-sum-array'),
        testStatus: 'GENERATION_FAILED',
        testFailure: 'The reference solution timed out',
      });
      db.put('Questions', { ...question('dev-reverse-string'), testStatus: 'NEEDS_REVIEW' });
    });

    await expect(ensureTests(aws, ids, clock, () => undefined)).rejects.toThrow(
      /dev-sum-array: GENERATION_FAILED: The reference solution timed out/,
    );
    await expect(
      ensureTests(
        aws,
        ids,
        fakeClock(() => undefined),
        () => undefined,
      ),
    ).rejects.toThrow(/did not finish in time/);
  });

  it('GenerationFailedError is an Error', () => {
    expect(new GenerationFailedError('x')).toBeInstanceOf(Error);
  });

  it('approveDirectly sets APPROVED and the test details', async () => {
    db.put('Questions', { ...question('dev-sum-array'), testStatus: 'NEEDS_REVIEW' });
    await approveDirectly('dev-sum-array', JSON.parse(tests('dev-sum-array')));
    expect(question('dev-sum-array')).toMatchObject({ testStatus: 'APPROVED', testCount: 10 });
  });
});

describe('describeTests', () => {
  it('shows the signature and every test', () => {
    const lines = describeTests({
      questionId: 'dev-sum-array',
      how: 'generated',
      question: {
        questionId: 'dev-sum-array',
        version: 1,
        signature: {
          name: 'sumArray',
          parameters: [{ name: 'nums', type: 'int[]' }],
          returnType: 'int',
        },
      } as QuestionItem,
      tests: JSON.parse(tests('dev-sum-array')),
    });
    expect(lines[0]).toBe('dev-sum-array (generated): sumArray(nums: int[]) -> int');
    expect(lines).toHaveLength(11);
    expect(lines[8]).toMatch(/test 7 \(large\)/);
  });
});

describe('submitPhoto', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1]);

  beforeEach(async () => {
    await ensureDevData(client, () => undefined);
  });

  it('uploads to the right answers/ key, counts attempt 1 as QUEUED and sends the TranscribeMsg', async () => {
    const { attempt, imageKey } = await submitPhoto(aws, PHOTOS[0], jpeg);

    expect(attempt).toBe(1);
    expect(imageKey).toBe('answers/dev-exam/DEV001/q1.jpg');
    expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'answers/dev-exam/DEV001/q1.jpg',
      ContentType: 'image/jpeg',
      Body: jpeg,
    });
    expect(answer(1)).toMatchObject({ attempt: 1, status: 'QUEUED', imageKey, dev: true });

    const sent = sqs.commandCalls(SendMessageCommand)[0]?.args[0].input;
    expect(sent).toMatchObject({
      QueueUrl: aws.transcribeQueueUrl,
      MessageGroupId: `${EXAM_ID}#${STUDENT_EMAIL}`,
      MessageDeduplicationId: `${EXAM_ID}#${STUDENT_EMAIL}#1#1`,
    });
    expect(transcribeMsg.parse(JSON.parse(sent?.MessageBody ?? ''))).toEqual({
      examId: EXAM_ID,
      studentEmail: STUDENT_EMAIL,
      questionNumber: 1,
      attempt: 1,
      questionId: 'dev-sum-array',
      version: 1,
    });
  });

  it('a second run sends the answer again as the next attempt, and only that', async () => {
    await submitPhoto(aws, PHOTOS[1], jpeg);
    db.put('Answers', { ...answer(2)!, status: 'GRADED', score: 5 });
    const second = await submitPhoto(aws, PHOTOS[1], jpeg);

    expect(second.attempt).toBe(2);
    expect(answer(2)).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(sqs.commandCalls(SendMessageCommand)[1]?.args[0].input.MessageDeduplicationId).toBe(
      `${EXAM_ID}#${STUDENT_EMAIL}#2#2`,
    );
    expect(answer(1)).toBeUndefined();
  });
});

describe('waiting for answers', () => {
  const graded = (n: number, extra: Partial<AnswerItem> = {}): AnswerItem => ({
    examStudent: `${EXAM_ID}#${STUDENT_EMAIL}`,
    questionNumber: n,
    attempt: 1,
    status: 'GRADED',
    ...extra,
  });

  it('waits until both are finished for this attempt, not an earlier one', async () => {
    db.put('Answers', graded(1, { attempt: 1 })); // an old, finished attempt
    db.put('Answers', graded(2, { status: 'RUNNING' }));
    const clock = fakeClock(() => {
      db.put('Answers', graded(1, { attempt: 2 }));
      db.put('Answers', graded(2, { status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE' }));
    });

    const result = await waitForAnswers(
      new Map([
        [1, 2],
        [2, 1],
      ]),
      clock,
      () => undefined,
    );

    expect(result?.map((a) => a.status)).toEqual(['GRADED', 'FAILED_TO_GRADE']);
    expect(clock.slept).toEqual([10_000]);
  });

  it('gives up after ten minutes', async () => {
    db.put('Answers', graded(1, { status: 'QUEUED' }));
    const clock = fakeClock();
    expect(await waitForAnswers(new Map([[1, 1]]), clock, () => undefined)).toBeUndefined();
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600_000);
    expect(clock.slept.length).toBeGreaterThan(50);
  });
});

describe('pollUntil', () => {
  it('returns the first value, or undefined at the deadline', async () => {
    let n = 0;
    expect(
      await pollUntil(async () => (++n === 3 ? 'done' : undefined), fakeClock(), {
        timeoutMs: 100,
        intervalMs: 10,
      }),
    ).toBe('done');
    expect(
      await pollUntil(async () => undefined, fakeClock(), { timeoutMs: 100, intervalMs: 10 }),
    ).toBeUndefined();
  });
});

describe('describeAnswer', () => {
  it('prints status, language, corrected code, fixes, tests, verdicts and score', () => {
    const text = describeAnswer(
      {
        examStudent: 'x',
        questionNumber: 1,
        attempt: 1,
        status: 'GRADED',
        language: 'cpp',
        correctedCode: 'int f() {\n  return 1;\n}',
        fixes: ['added a semicolon'],
        estimatedComplexity: 'O(n)',
        meetsComplexity: true,
        testsPassed: 9,
        testsTotal: 10,
        verdicts: [
          { index: 0, kind: 'small', verdict: 'WA', input: '{"x":1}', expected: '2', actual: '1' },
          { index: 7, kind: 'large', verdict: 'AC' },
        ],
        score: 4.5,
      },
      5,
    ).join('\n');

    expect(text).toContain('Question 1: GRADED');
    expect(text).toContain('language:  cpp');
    expect(text).toContain('| int f() {');
    expect(text).toContain('- added a semicolon');
    expect(text).toContain('9/10 passed');
    expect(text).toContain('test 0 (small): WA  input {"x":1}, expected 2, got 1');
    expect(text).toContain('test 7 (large): AC');
    expect(text).toContain('score:     4.5 of 5');
  });

  it('shows why an answer failed', () => {
    const text = describeAnswer(
      {
        examStudent: 'x',
        questionNumber: 2,
        attempt: 1,
        status: 'FAILED_TO_GRADE',
        failReason: 'UNREADABLE',
        failDetail: 'blurry',
      },
      5,
    ).join('\n');
    expect(text).toContain('FAILED_TO_GRADE (UNREADABLE: blurry)');
    expect(text).toContain('score:     0 of 5');
  });
});

describe('readTotals', () => {
  const exam: ExamItem = {
    examId: EXAM_ID,
    batchId: BATCH_ID,
    title: 'dev-exam',
    date: '2026-10-17',
    questions: [
      { number: 1, questionId: 'a', version: 1, marks: 5 },
      { number: 2, questionId: 'b', version: 1, marks: 5 },
    ],
    createdBy: 't',
    status: 'READY',
  };
  const graded = (n: number, passed: number): AnswerItem => ({
    examStudent: `${EXAM_ID}#${STUDENT_EMAIL}`,
    questionNumber: n,
    attempt: 1,
    status: 'GRADED',
    testsPassed: passed,
    testsTotal: 10,
    meetsComplexity: true,
  });

  it('matches when the Record Lambda stored the same total', async () => {
    db.put('ExamStudents', {
      examId: EXAM_ID,
      studentEmail: STUDENT_EMAIL,
      absent: false,
      totalScore: 7.5,
      maxScore: 10,
    });
    const result = await readTotals(exam, [graded(1, 10), graded(2, 5)], fakeClock());
    expect(result.expected).toEqual({ totalScore: 7.5, maxScore: 10 });
    expect(result.matches).toBe(true);
  });

  it('says so when the stored total differs', async () => {
    db.put('ExamStudents', {
      examId: EXAM_ID,
      studentEmail: STUDENT_EMAIL,
      absent: false,
      totalScore: 1,
      maxScore: 10,
    });
    const result = await readTotals(exam, [graded(1, 10), graded(2, 5)], fakeClock());
    expect(result.matches).toBe(false);
    expect(result.stored?.totalScore).toBe(1);
  });
});

describe('the dev photos', () => {
  it('are the two the user named, for questions 1 and 2', () => {
    expect(PHOTOS.map((p) => [p.number, p.questionId, p.file])).toEqual([
      [1, 'dev-sum-array', 'sum.jpeg'],
      [2, 'dev-reverse-string', 'reverse.jpeg'],
    ]);
    expect(STUDENT_ROLL).toBe('DEV001');
  });
});
