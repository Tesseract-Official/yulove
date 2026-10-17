// End-to-end run of the real pipeline on dev data. It skips API Gateway but uses everything
// behind it: DynamoDB, S3, the queues, the test-generation, Transcribe and Record Lambdas, the
// Fargate worker, and the real Gemini API. It leaves the dev data in place and is safe to run
// again (a second run only sends the two answers again as a new attempt).
//
//   AWS_PROFILE=dsa-judge pnpm e2e:pipeline
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  answerImageKey,
  ConflictError,
  messageDeduplicationId,
  messageGroupId,
  questionKeys,
  TABLE_ENV,
  TABLE_NAMES,
  TESTGEN_FUNCTION_ENV,
  testsFileSchema,
  transcribeMsg,
  type AnswerItem,
  type ExamItem,
  type ExamStudentItem,
  type QuestionItem,
  type TestsFile,
} from '@yulove/shared';
import {
  answersDb,
  batchesDb,
  docClient,
  examStudentsDb,
  examsDb,
  questionsDb,
  tableName,
  totalFor,
  usersDb,
} from '@yulove/shared/server';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEV_QUESTIONS, DEV_TEACHER, seedDevQuestions } from './seed-dev-questions.js';
import { DATA_STACK, REGION } from './seed-super-admins.js';
import { queueUrlFromOutputs, QUEUES_STACK, requiredOutput, stackOutputs } from './smoke-worker.js';

export const PIPELINE_STACK = 'DsaJudgePipeline';
export const BATCH_ID = 'dev-batch';
export const EXAM_ID = 'dev-exam';
export const STUDENT_EMAIL = 'dev-student@medhaviskillsuniversity.edu.in';
export const STUDENT_ROLL = 'DEV001';
export const MARKS = 5;
export const WAIT_MINUTES = 10;
export const POLL_SECONDS = 10;

/** The two photos, and the question each one answers. */
export const PHOTOS = [
  { number: 1, questionId: 'dev-sum-array', file: 'sum.jpeg' },
  { number: 2, questionId: 'dev-reverse-string', file: 'reverse.jpeg' },
] as const;

const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
export const realClock: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Aws {
  bucket: string;
  transcribeQueueUrl: string;
  testgenFunction: string;
  s3: S3Client;
  sqs: SQSClient;
  lambda: LambdaClient;
}

type Log = (line: string) => void;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------
// 1. Dev data

/**
 * Adds whatever of the dev batch, student and the two questions does not exist yet, each marked
 * dev. Never overwrites. Needs the table environment variables (see `useTables`).
 */
export async function ensureDevData(
  questionsClient: DynamoDBDocumentClient,
  log: Log,
): Promise<void> {
  try {
    await batchesDb.createBatch({ batchId: BATCH_ID, name: 'Dev batch', dev: true });
    log(`Added batch ${BATCH_ID}.`);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    log(`Batch ${BATCH_ID} is already there.`);
  }

  try {
    await usersDb.createUser({
      email: STUDENT_EMAIL,
      role: 'STUDENT',
      name: 'Dev Student',
      rollNo: STUDENT_ROLL,
      batchId: BATCH_ID,
      active: true,
      dev: true,
    });
    log(`Added student ${STUDENT_EMAIL} (${STUDENT_ROLL}).`);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    log(`Student ${STUDENT_EMAIL} is already there.`);
  }

  const table = tableName('Questions');
  for (const outcome of await seedDevQuestions(questionsClient, table)) {
    log(
      outcome.status === 'created'
        ? `Added question ${outcome.questionId}.`
        : `Question ${outcome.questionId} is already there.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Tests for each question

export interface TestsOutcome {
  questionId: string;
  how: 'existing' | 'generated';
  question: QuestionItem;
  tests: TestsFile;
}

export class GenerationFailedError extends Error {}

/** True when tests.json for the question version is in S3. */
export async function hasTests(aws: Pick<Aws, 's3' | 'bucket'>, questionId: string, version = 1) {
  try {
    await aws.s3.send(
      new HeadObjectCommand({ Bucket: aws.bucket, Key: questionKeys(questionId, version).tests }),
    );
    return true;
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

export async function readTests(
  aws: Pick<Aws, 's3' | 'bucket'>,
  questionId: string,
  version = 1,
): Promise<TestsFile> {
  const out = await aws.s3.send(
    new GetObjectCommand({ Bucket: aws.bucket, Key: questionKeys(questionId, version).tests }),
  );
  return testsFileSchema.parse(JSON.parse((await out.Body?.transformToString('utf8')) ?? '{}'));
}

/** Calls `fn` every few seconds until it returns a value, or the time is up (then undefined). */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  clock: Clock,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (clock.now() + intervalMs > deadline) return undefined;
    await clock.sleep(intervalMs);
  }
}

/**
 * Starts test generation for a question that has no tests yet: a new round, then the
 * test-generation Lambda. Gemini writes the reference solution, the worker runs it, and the Record
 * Lambda moves the question to NEEDS_REVIEW (or GENERATION_FAILED).
 */
export async function startGeneration(aws: Aws, questionId: string): Promise<number> {
  const attempt = await questionsDb.beginGeneration(questionId, 1);
  if (attempt === undefined) throw new Error(`Question ${questionId} does not exist`);
  const out = await aws.lambda.send(
    new InvokeCommand({
      FunctionName: aws.testgenFunction,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(
        JSON.stringify({ mode: 'generate', questionId, version: 1, attempt }),
      ),
    }),
  );
  if (out.StatusCode !== 202) throw new Error(`Lambda invoke returned ${String(out.StatusCode)}`);
  return attempt;
}

/** Sets the question APPROVED directly (a teacher would press Approve). */
export async function approveDirectly(questionId: string, tests: TestsFile): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName('Questions'),
      Key: { questionId, version: 1 },
      UpdateExpression: 'SET #status = :approved, #count = :count, #key = :key',
      ExpressionAttributeNames: {
        '#status': 'testStatus',
        '#count': 'testCount',
        '#key': 'testsKey',
      },
      ExpressionAttributeValues: {
        ':approved': 'APPROVED',
        ':count': tests.tests.length,
        ':key': questionKeys(questionId, 1).tests,
      },
    }),
  );
}

/**
 * Makes sure every question has tests and is APPROVED. Questions that already have tests are left
 * as they are; the others are generated together and waited for (up to 10 minutes).
 */
export async function ensureTests(
  aws: Aws,
  questionIds: readonly string[],
  clock: Clock,
  log: Log,
): Promise<TestsOutcome[]> {
  const missing: string[] = [];
  for (const id of questionIds) {
    if (await hasTests(aws, id)) log(`${id}: tests already exist.`);
    else missing.push(id);
  }

  for (const id of missing) {
    const attempt = await startGeneration(aws, id);
    log(`${id}: test generation started (round ${attempt}).`);
  }

  if (missing.length > 0) {
    log(
      `Waiting up to ${WAIT_MINUTES} minutes for ${missing.join(', ')} (the worker starts from zero tasks)...`,
    );
    const last = new Map<string, string>();
    const settled = await pollUntil(
      async () => {
        const states = await Promise.all(
          missing.map(async (id) => ({ id, q: await questionsDb.getQuestion(id, 1) })),
        );
        for (const { id, q } of states) {
          const now = q?.testStatus ?? 'missing';
          if (last.get(id) !== now) {
            last.set(id, now);
            log(`  ${id}: ${now}`);
          }
        }
        const done = states.every(
          ({ q }) => q?.testStatus === 'NEEDS_REVIEW' || q?.testStatus === 'GENERATION_FAILED',
        );
        return done ? states : undefined;
      },
      clock,
      { timeoutMs: WAIT_MINUTES * 60_000, intervalMs: POLL_SECONDS * 1000 },
    );
    if (!settled) throw new Error('Test generation did not finish in time.');
    for (const { id, q } of settled) {
      if (q?.testStatus === 'GENERATION_FAILED') {
        throw new GenerationFailedError(
          `${id}: GENERATION_FAILED: ${q.testFailure ?? 'no reason given'}`,
        );
      }
    }
  }

  const outcomes: TestsOutcome[] = [];
  for (const id of questionIds) {
    const tests = await readTests(aws, id);
    const question = (await questionsDb.getQuestion(id, 1)) as QuestionItem;
    if (question.testStatus !== 'APPROVED') {
      await approveDirectly(id, tests);
      log(`${id}: set APPROVED.`);
    }
    outcomes.push({
      questionId: id,
      how: missing.includes(id) ? 'generated' : 'existing',
      question: { ...question, testStatus: 'APPROVED' },
      tests,
    });
  }
  return outcomes;
}

/** The signature and the ten tests, ready to print. */
export function describeTests(outcome: TestsOutcome): string[] {
  const { question, tests } = outcome;
  const sig = question.signature;
  const lines = [
    `${outcome.questionId} (${outcome.how}): ${
      sig
        ? `${sig.name}(${sig.parameters.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${sig.returnType}`
        : 'no signature'
    }`,
  ];
  for (const t of [...tests.tests].sort((a, b) => a.index - b.index)) {
    const cut = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}...` : text);
    lines.push(
      `  test ${t.index} (${t.kind}): input ${cut(t.input)}  ->  expected ${cut(t.expected)}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// 3. The exam

/** Creates dev-exam (READY) and the student's ExamStudents row if they are not there. */
export async function ensureExam(log: Log, today: string): Promise<ExamItem> {
  const exam: ExamItem = {
    examId: EXAM_ID,
    batchId: BATCH_ID,
    title: 'dev-exam',
    date: today,
    questions: PHOTOS.map((p) => ({
      number: p.number,
      questionId: p.questionId,
      version: 1,
      marks: MARKS,
    })),
    createdBy: DEV_TEACHER,
    status: 'READY',
    dev: true,
  };
  try {
    await examsDb.createExam(exam);
    log(`Created exam ${EXAM_ID} (READY, ${PHOTOS.length} questions of ${MARKS} marks).`);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    log(`Exam ${EXAM_ID} is already there.`);
  }
  const stored = (await examsDb.getExam(EXAM_ID)) as ExamItem;

  if (!(await examStudentsDb.getExamStudent(EXAM_ID, STUDENT_EMAIL))) {
    const row: ExamStudentItem = {
      examId: EXAM_ID,
      studentEmail: STUDENT_EMAIL,
      absent: false,
      dev: true,
    };
    await examStudentsDb.putExamStudent(row);
    log(`Added the exam row for ${STUDENT_EMAIL}.`);
  }
  return stored;
}

// ---------------------------------------------------------------------------------------------
// 4. Photos

/**
 * Uploads a photo to its answers/ key and submits it the way POST /answers/submit does: counts
 * the attempt (QUEUED) and sends the TranscribeMsg. Returns the attempt.
 */
export async function submitPhoto(
  aws: Aws,
  photo: { number: number; questionId: string },
  jpeg: Uint8Array,
): Promise<{ attempt: number; imageKey: string }> {
  const imageKey = answerImageKey(EXAM_ID, STUDENT_ROLL, photo.number);
  await aws.s3.send(
    new PutObjectCommand({
      Bucket: aws.bucket,
      Key: imageKey,
      Body: jpeg,
      ContentType: 'image/jpeg',
    }),
  );

  const key = { examId: EXAM_ID, studentEmail: STUDENT_EMAIL, questionNumber: photo.number };
  const attempt = await answersDb.beginAttempt(key, imageKey);
  await docClient().send(
    new UpdateCommand({
      TableName: tableName('Answers'),
      Key: { examStudent: `${EXAM_ID}#${STUDENT_EMAIL}`, questionNumber: photo.number },
      UpdateExpression: 'SET dev = :yes',
      ExpressionAttributeValues: { ':yes': true },
    }),
  );

  const message = transcribeMsg.parse({
    ...key,
    attempt,
    questionId: photo.questionId,
    version: 1,
  });
  await aws.sqs.send(
    new SendMessageCommand({
      QueueUrl: aws.transcribeQueueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: messageGroupId(EXAM_ID, STUDENT_EMAIL),
      MessageDeduplicationId: messageDeduplicationId(EXAM_ID, STUDENT_EMAIL, photo.number, attempt),
    }),
  );
  return { attempt, imageKey };
}

// ---------------------------------------------------------------------------------------------
// 5. Results

const FINISHED = new Set(['GRADED', 'FAILED_TO_GRADE']);

/** Waits until every answer has reached its attempt's end (GRADED or FAILED_TO_GRADE). */
export async function waitForAnswers(
  attempts: ReadonlyMap<number, number>,
  clock: Clock,
  log: Log,
): Promise<AnswerItem[] | undefined> {
  const last = new Map<number, string>();
  return pollUntil(
    async () => {
      const answers = await Promise.all(
        [...attempts.keys()].map((n) =>
          answersDb.getAnswer({ examId: EXAM_ID, studentEmail: STUDENT_EMAIL, questionNumber: n }),
        ),
      );
      answers.forEach((a, i) => {
        const n = [...attempts.keys()][i] as number;
        const text = a ? `${a.status} (attempt ${a.attempt})` : 'missing';
        if (last.get(n) !== text) {
          last.set(n, text);
          log(`  Q${n}: ${text}`);
        }
      });
      const done = answers.every(
        (a, i) =>
          a &&
          a.attempt === attempts.get([...attempts.keys()][i] as number) &&
          FINISHED.has(a.status),
      );
      return done ? (answers as AnswerItem[]) : undefined;
    },
    clock,
    { timeoutMs: WAIT_MINUTES * 60_000, intervalMs: POLL_SECONDS * 1000 },
  );
}

/** One answer, printed in full. */
export function describeAnswer(answer: AnswerItem, marks: number): string[] {
  const lines = [
    `Question ${answer.questionNumber}: ${answer.status}${answer.failReason ? ` (${answer.failReason}${answer.failDetail ? `: ${answer.failDetail}` : ''})` : ''}`,
    `  attempt:   ${answer.attempt}`,
    `  language:  ${answer.language ?? '-'}`,
    `  complexity: ${answer.estimatedComplexity ?? '-'} (meets target: ${String(answer.meetsComplexity ?? '-')})`,
    '  corrected code:',
    ...(answer.correctedCode ?? '(none)').split('\n').map((l) => `    | ${l}`),
    `  fixes:     ${answer.fixes && answer.fixes.length > 0 ? '' : '(none)'}`,
    ...(answer.fixes ?? []).map((f) => `    - ${f}`),
    `  tests:     ${answer.testsPassed ?? '-'}/${answer.testsTotal ?? '-'} passed`,
  ];
  for (const v of answer.verdicts ?? []) {
    const detail =
      v.input !== undefined
        ? `  input ${v.input}, expected ${v.expected ?? ''}, got ${v.actual ?? ''}`
        : '';
    lines.push(`    test ${v.index} (${v.kind}): ${v.verdict}${detail}`);
  }
  lines.push(`  score:     ${answer.score ?? 0} of ${marks}`);
  return lines;
}

/** The total as the Record Lambda stored it, next to what the shared scoring says. */
export async function readTotals(exam: ExamItem, answers: AnswerItem[], clock: Clock) {
  const expected = totalFor(exam, answers, false);
  // The Record Lambda writes the total right after the answer; give it a moment.
  const stored = await pollUntil(
    async () => {
      const row = await examStudentsDb.getExamStudent(EXAM_ID, STUDENT_EMAIL);
      return row?.totalScore === expected.totalScore && row?.maxScore === expected.maxScore
        ? row
        : undefined;
    },
    clock,
    { timeoutMs: 30_000, intervalMs: 2000 },
  );
  const row = stored ?? (await examStudentsDb.getExamStudent(EXAM_ID, STUDENT_EMAIL));
  return { expected, stored: row, matches: stored !== undefined };
}

// ---------------------------------------------------------------------------------------------
// The run

export interface RunResult {
  ok: boolean;
}

export async function run(
  aws: Aws,
  questionsClient: DynamoDBDocumentClient,
  clock: Clock,
  log: Log,
): Promise<RunResult> {
  log('== 1. Dev data');
  await ensureDevData(questionsClient, log);

  log('\n== 2. Tests');
  const outcomes = await ensureTests(
    aws,
    PHOTOS.map((p) => p.questionId),
    clock,
    log,
  );
  for (const outcome of outcomes) for (const line of describeTests(outcome)) log(line);

  log('\n== 3. Exam');
  const exam = await ensureExam(log, new Date(clock.now()).toISOString().slice(0, 10));

  log('\n== 4. Photos');
  const attempts = new Map<number, number>();
  for (const photo of PHOTOS) {
    const jpeg = new Uint8Array(readFileSync(repoFile(photo.file)));
    const { attempt, imageKey } = await submitPhoto(aws, photo, jpeg);
    attempts.set(photo.number, attempt);
    log(
      `Q${photo.number}: uploaded ${photo.file} (${jpeg.length} bytes) to ${imageKey}; attempt ${attempt} queued.`,
    );
  }

  log(`\n== 5. Waiting up to ${WAIT_MINUTES} minutes for grading`);
  const answers = await waitForAnswers(attempts, clock, log);
  if (!answers) {
    log('Grading did not finish in time.');
    return { ok: false };
  }

  log('\n== Results');
  for (const answer of answers) {
    const marks = exam.questions.find((q) => q.number === answer.questionNumber)?.marks ?? 0;
    for (const line of describeAnswer(answer, marks)) log(line);
    log('');
  }
  const { expected, stored, matches } = await readTotals(exam, answers, clock);
  log(
    `Exam total: ${stored?.totalScore ?? '-'} of ${stored?.maxScore ?? '-'} (stored by the Record Lambda); ${expected.totalScore} of ${expected.maxScore} by the shared scoring${matches ? '' : '  <-- DIFFERENT'}.`,
  );
  return { ok: answers.every((a) => a.status === 'GRADED') && matches };
}

/** Table names and the test-generation function, read from the deployed stacks. */
export async function connect(
  region = REGION,
): Promise<{ aws: Aws; questionsClient: DynamoDBDocumentClient }> {
  const cfn = new CloudFormationClient({ region });
  const [data, queues, resources] = await Promise.all([
    stackOutputs(cfn, DATA_STACK),
    stackOutputs(cfn, QUEUES_STACK),
    cfn.send(new DescribeStackResourcesCommand({ StackName: PIPELINE_STACK })),
  ]);
  for (const name of TABLE_NAMES) {
    process.env[TABLE_ENV[name]] = requiredOutput(data, `${name}TableName`, DATA_STACK);
  }
  const testgen = resources.StackResources?.find(
    (r) =>
      r.ResourceType === 'AWS::Lambda::Function' &&
      r.LogicalResourceId?.startsWith('TestGenerationFunction'),
  )?.PhysicalResourceId;
  if (!testgen) throw new Error(`No test-generation Lambda in stack ${PIPELINE_STACK}.`);
  process.env[TESTGEN_FUNCTION_ENV] = testgen;

  return {
    aws: {
      bucket: requiredOutput(data, 'BucketName', DATA_STACK),
      transcribeQueueUrl: queueUrlFromOutputs(queues, 'transcribe'),
      testgenFunction: testgen,
      s3: new S3Client({ region }),
      sqs: new SQSClient({ region }),
      lambda: new LambdaClient({ region }),
    },
    questionsClient: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
  };
}

async function main(): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) throw new Error('Set AWS_PROFILE, e.g. AWS_PROFILE=dsa-judge pnpm e2e:pipeline');
  process.env['AWS_REGION'] ??= REGION;

  const { aws, questionsClient } = await connect();
  console.log(
    `Profile ${profile}, bucket ${aws.bucket}, test generation ${aws.testgenFunction}.\n`,
  );
  const result = await run(aws, questionsClient, realClock, (line) => console.log(line));
  console.log(result.ok ? '\nPASS' : '\nFAIL');
  if (!result.ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}

export { DEV_QUESTIONS };
