// Smoke test for the deployed execution worker. Uploads a tiny fixture question, sends a SETUP and
// then two ANSWER messages (Python and C++) through the real execute queue, waits for the results
// from the worker (which starts from zero tasks), prints the verdicts and cleans up after itself.
//
//   AWS_PROFILE=dsa-judge pnpm smoke:worker
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  executeMsg,
  messageDeduplicationId,
  messageGroupId,
  resultMsg,
  setupDeduplicationId,
  setupGroupId,
  type ExecuteMsg,
  type ResultMsg,
} from '@yulove/shared';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_STACK, REGION } from './seed-super-admins.js';

export const QUEUES_STACK = 'DsaJudgeQueues';
export const AUTH_STACK = 'DsaJudgeAuth';

/** The worker reads questions/* and writes questions/<id>/v<n>/tests.json, so the fixture lives there. */
export const QUESTION_ID = 'smoke';
export const WAIT_MINUTES = 8;
export const LOGIN_REDIRECT = 'http://localhost:5173/auth/callback';

const SMALL_COUNT = 7;
const LARGE_COUNT = 3;
const LIMITS = { timeLimitMs: 2000, memoryMb: 256, compareMode: 'EXACT' } as const;

// ---------------------------------------------------------------------------------------------
// The fixture question: sum of a list of numbers.

export const REFERENCE_PY = `import json
import sys

data = json.loads(sys.stdin.read())
print(json.dumps(sum(data["nums"])))
`;

/**
 * Prints one large input per call. The first also carries a "probe": where the sandbox runs and
 * how many CPUs it can use. The worker does not log either, but the probe is stored in tests.json
 * as that input, so the smoke test can read it back. sched_getaffinity is the source Node's
 * availableParallelism() uses.
 */
export const GENERATOR_PY = `import json
import os
import sys

i = int(sys.argv[1])
out = {"nums": list(range(1, 1000 * (i + 1) + 1))}
if i == 0:
    out["probe"] = {
        "cwd": os.getcwd(),
        "cpuCount": os.cpu_count(),
        "usableCpus": len(os.sched_getaffinity(0)),
    }
print(json.dumps(out))
`;

/** Seven small inputs, each one JSON object (as text). */
export function smallInputs(): string[] {
  return Array.from({ length: SMALL_COUNT }, (_, i) =>
    JSON.stringify({ nums: Array.from({ length: i }, (_, k) => k * 3 - 2) }),
  );
}

export const PYTHON_STUDENT_CODE = `def solve(nums):
    return sum(nums)`;

export const PYTHON_DRIVER = `import json
import sys

${PYTHON_STUDENT_CODE}

data = json.loads(sys.stdin.read())
print(json.dumps(solve(data["nums"])))
`;

export const CPP_STUDENT_CODE = `long long solve(const std::vector<long long>& nums) {
    long long total = 0;
    for (long long x : nums) total += x;
    return total;
}`;

export const CPP_DRIVER = `#include <nlohmann/json.hpp>

#include <iostream>
#include <vector>

${CPP_STUDENT_CODE}

int main() {
    nlohmann::json input = nlohmann::json::parse(std::cin);
    std::vector<long long> nums = input.at("nums").get<std::vector<long long>>();
    std::cout << nlohmann::json(solve(nums)).dump() << std::endl;
    return 0;
}
`;

// ---------------------------------------------------------------------------------------------
// Stack outputs and the login URL.

export async function stackOutputs(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<Record<string, string>> {
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs: Record<string, string> = {};
  for (const o of Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue !== undefined) outputs[o.OutputKey] = o.OutputValue;
  }
  return outputs;
}

/**
 * The queue's URL among a stack's outputs. The Queues stack exports its URLs under generated
 * output names, so this looks for the value (an SQS URL ending /<name>.fifo), not the name.
 */
export function queueUrlFromOutputs(outputs: Record<string, string>, queue: string): string {
  const found = Object.values(outputs).find((value) =>
    new RegExp(`^https://sqs\\.[a-z0-9-]+\\.amazonaws\\.com/\\d+/${queue}\\.fifo$`).test(value),
  );
  if (!found) throw new Error(`No ${queue}.fifo URL among the outputs of ${QUEUES_STACK}.`);
  return found;
}

export function requiredOutput(outputs: Record<string, string>, key: string, stack: string) {
  const value = outputs[key];
  if (!value) throw new Error(`Stack ${stack} has no output ${key}.`);
  return value;
}

/** The Cognito hosted UI sign-in page: authorization code flow, Google as the provider. */
export function loginUrl(hostedUiBaseUrl: string, clientId: string): string {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: LOGIN_REDIRECT,
    identity_provider: 'Google',
  });
  return `${hostedUiBaseUrl.replace(/\/+$/, '')}/oauth2/authorize?${query.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// The run: ids, keys and messages.

export interface Run {
  /** Version number of the fixture question, also the run's identity (unix seconds). */
  version: number;
  examId: string;
  prefix: string;
  referenceKey: string;
  generatorKey: string;
  smallInputsKey: string;
  testsKey: string;
}

export function newRun(now: Date = new Date()): Run {
  const version = Math.floor(now.getTime() / 1000);
  const prefix = `questions/${QUESTION_ID}/v${version}/`;
  return {
    version,
    examId: `smoke-${version}`,
    prefix,
    referenceKey: `${prefix}reference.py`,
    generatorKey: `${prefix}generator.py`,
    smallInputsKey: `${prefix}small-inputs.json`,
    testsKey: `${prefix}tests.json`,
  };
}

export function setupMessage(run: Run): ExecuteMsg {
  return executeMsg.parse({
    type: 'SETUP',
    questionId: QUESTION_ID,
    version: run.version,
    attempt: 1,
    referenceKey: run.referenceKey,
    generatorKey: run.generatorKey,
    smallInputs: smallInputs(),
    largeInputCount: LARGE_COUNT,
    testsKey: run.testsKey,
    ...LIMITS,
  });
}

export interface AnswerCase {
  name: string;
  studentEmail: string;
  questionNumber: number;
  language: 'python' | 'cpp';
  correctedCode: string;
  driverCode: string;
}

export const ANSWER_CASES: readonly AnswerCase[] = [
  {
    name: 'Python',
    studentEmail: 'smoke-python@example.invalid',
    questionNumber: 1,
    language: 'python',
    correctedCode: PYTHON_STUDENT_CODE,
    driverCode: PYTHON_DRIVER,
  },
  {
    name: 'C++',
    studentEmail: 'smoke-cpp@example.invalid',
    questionNumber: 2,
    language: 'cpp',
    correctedCode: CPP_STUDENT_CODE,
    driverCode: CPP_DRIVER,
  },
];

export function answerMessage(run: Run, c: AnswerCase): ExecuteMsg {
  return executeMsg.parse({
    type: 'ANSWER',
    examId: run.examId,
    studentEmail: c.studentEmail,
    questionNumber: c.questionNumber,
    attempt: 1,
    questionId: QUESTION_ID,
    version: run.version,
    language: c.language,
    correctedCode: c.correctedCode,
    driverCode: c.driverCode,
    testsKey: run.testsKey,
    ...LIMITS,
  });
}

/** Group and deduplication ids, built the same way the API will build them. */
export function fifoIds(msg: ExecuteMsg): { groupId: string; deduplicationId: string } {
  if (msg.type === 'SETUP') {
    return {
      groupId: setupGroupId(msg.questionId),
      deduplicationId: setupDeduplicationId(msg.questionId, msg.version, msg.attempt),
    };
  }
  return {
    groupId: messageGroupId(msg.examId, msg.studentEmail),
    deduplicationId: messageDeduplicationId(
      msg.examId,
      msg.studentEmail,
      msg.questionNumber,
      msg.attempt,
    ),
  };
}

export async function sendExecute(sqs: SQSClient, queueUrl: string, msg: ExecuteMsg) {
  const { groupId, deduplicationId } = fifoIds(msg);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(msg),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function uploadFixture(s3: S3Client, bucket: string, run: Run) {
  const files: Array<[string, string, string]> = [
    [run.referenceKey, REFERENCE_PY, 'text/x-python'],
    [run.generatorKey, GENERATOR_PY, 'text/x-python'],
    [run.smallInputsKey, JSON.stringify(smallInputs()), 'application/json'],
  ];
  for (const [Key, Body, ContentType] of files) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType }));
  }
}

// ---------------------------------------------------------------------------------------------
// Waiting for results.

export interface PollDeps {
  /** Milliseconds since the epoch; replaced in tests. */
  now?: () => number;
}

/** Whether a result belongs to this run and to the message it is waiting for. */
export type Wanted = (result: ResultMsg) => boolean;

export const wantSetup =
  (run: Run): Wanted =>
  (r) =>
    r.type === 'SETUP' && r.questionId === QUESTION_ID && r.version === run.version;

export const wantAnswer =
  (run: Run, c: AnswerCase): Wanted =>
  (r) =>
    r.type === 'ANSWER' &&
    r.examId === run.examId &&
    r.studentEmail === c.studentEmail &&
    r.questionNumber === c.questionNumber;

/**
 * Reads the results queue until every wanted result has arrived or the deadline passes. A result
 * that matches is deleted at once. Any other message (someone else's, or not a result) is given
 * back immediately and left alone. Returns the results found, in the order wanted.
 */
export async function waitForResults(
  sqs: SQSClient,
  queueUrl: string,
  wanted: Wanted[],
  deadline: number,
  { now = Date.now }: PollDeps = {},
): Promise<Array<ResultMsg | undefined>> {
  const found: Array<ResultMsg | undefined> = wanted.map(() => undefined);

  while (found.some((r) => r === undefined) && now() < deadline) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 60,
      }),
    );
    for (const message of Messages ?? []) {
      const index = matchIndex(message, wanted, found);
      if (index >= 0 && message.ReceiptHandle) {
        found[index] = parseResult(message) as ResultMsg;
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      } else if (message.ReceiptHandle) {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      }
    }
  }
  return found;
}

function parseResult(message: Message): ResultMsg | undefined {
  try {
    const parsed = resultMsg.safeParse(JSON.parse(message.Body ?? ''));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function matchIndex(message: Message, wanted: Wanted[], found: Array<ResultMsg | undefined>) {
  const result = parseResult(message);
  if (!result) return -1;
  return wanted.findIndex((matches, i) => found[i] === undefined && matches(result));
}

// ---------------------------------------------------------------------------------------------
// Reading and describing what came back.

export interface Probe {
  cwd?: string;
  cpuCount?: number;
  usableCpus?: number;
}

export interface StoredTest {
  index: number;
  kind: string;
  input: string;
  expected: string;
}

export async function readTests(s3: S3Client, bucket: string, key: string) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const file = JSON.parse((await out.Body?.transformToString('utf8')) ?? '{}') as {
    tests?: StoredTest[];
  };
  return file.tests ?? [];
}

/** The sandbox probe the generator put into its first large input, if present. */
export function probeFrom(tests: StoredTest[]): Probe | undefined {
  for (const test of tests) {
    try {
      const input = JSON.parse(test.input) as { probe?: Probe };
      if (input.probe && typeof input.probe === 'object') return input.probe;
    } catch {
      // not JSON: not ours
    }
  }
  return undefined;
}

/** One line for a result: what happened, with verdict counts for an answer. */
export function describeResult(result: ResultMsg | undefined): string {
  if (!result) return 'no result before the deadline';
  if (result.type === 'SETUP') {
    if (result.outcome === 'OK')
      return `OK, ${result.testCount} tests written to ${result.testsKey}`;
    if (result.outcome === 'REFERENCE_FAILED') {
      return `REFERENCE_FAILED on inputs ${result.failedInputIndexes.join(', ')}: ${result.reason}`;
    }
    return `FAILED: ${result.reason}`;
  }
  if (result.outcome === 'FAILED') {
    return `FAILED (${result.failReason})${result.detail ? `: ${result.detail}` : ''}`;
  }
  const counts = new Map<string, number>();
  for (const v of result.verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  const summary = [...counts].map(([verdict, n]) => `${verdict}×${n}`).join(' ');
  return `COMPLETED: ${summary || 'no verdicts'}`;
}

/** True when an answer result is COMPLETED with an AC on every one of the 10 tests. */
export function isAllAccepted(result: ResultMsg | undefined): boolean {
  return (
    result?.type === 'ANSWER' &&
    result.outcome === 'COMPLETED' &&
    result.verdicts.length === 10 &&
    result.verdicts.every((v) => v.verdict === 'AC')
  );
}

// ---------------------------------------------------------------------------------------------
// Cleanup.

export interface CleanupReport {
  deleted: number;
  /** What could not be removed, with the reason. Empty when everything is gone. */
  problems: string[];
}

/**
 * Removes every object under the run's prefix, with all its versions and delete markers (the
 * bucket is versioned). If deleting versions is not allowed, falls back to a plain delete, which
 * leaves the old versions in the bucket, and says so.
 */
export async function deleteRunFiles(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: 0, problems: [] };
  const targets: Array<{ Key: string; VersionId?: string }> = [];

  try {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
        }),
      );
      for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (item.Key?.startsWith(prefix)) {
          targets.push({ Key: item.Key, ...(item.VersionId ? { VersionId: item.VersionId } : {}) });
        }
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker || versionMarker);
  } catch (error) {
    report.problems.push(`could not list ${prefix}: ${errorText(error)}`);
    return report;
  }

  for (let i = 0; i < targets.length; i += 1000) {
    const batch = targets.slice(i, i + 1000);
    const failed = await deleteBatch(s3, bucket, batch);
    if (failed.length === 0) {
      report.deleted += batch.length;
      continue;
    }
    // Probably no permission to delete versions: remove the current objects at least.
    const plain = [...new Set(failed.map((t) => t.Key))].map((Key) => ({ Key }));
    const plainFailed = await deleteBatch(s3, bucket, plain);
    report.deleted += batch.length - failed.length;
    report.problems.push(
      plainFailed.length === 0
        ? `old versions of ${plain.length} file(s) under ${prefix} remain (delete markers were added instead)`
        : `${plainFailed.length} file(s) under ${prefix} could not be deleted`,
    );
  }
  return report;
}

/** Deletes objects; returns the ones that could not be deleted. */
async function deleteBatch(
  s3: S3Client,
  bucket: string,
  objects: Array<{ Key: string; VersionId?: string }>,
) {
  if (objects.length === 0) return [];
  try {
    const out = await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
    );
    const errors = new Set((out.Errors ?? []).map((e) => `${e.Key}\u0000${e.VersionId ?? ''}`));
    return objects.filter((o) => errors.has(`${o.Key}\u0000${o.VersionId ?? ''}`));
  } catch {
    return objects;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// The run itself.

export interface Outcome {
  passed: boolean;
  lines: string[];
}

export interface Clients {
  s3: S3Client;
  sqs: SQSClient;
}

/** Runs the whole smoke test against the given queues and bucket. */
export async function smoke(
  { s3, sqs }: Clients,
  config: { bucket: string; executeUrl: string; resultsUrl: string },
  log: (line: string) => void = console.log,
  deps: PollDeps & { run?: Run } = {},
): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  const run = deps.run ?? newRun(new Date(now()));
  const deadline = now() + WAIT_MINUTES * 60_000;
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };
  let passed = false;

  try {
    say(`Run ${run.examId}; fixture at s3://${config.bucket}/${run.prefix}`);
    await uploadFixture(s3, config.bucket, run);

    say(
      `Sending SETUP; waiting up to ${WAIT_MINUTES} minutes (the worker starts from zero tasks)...`,
    );
    await sendExecute(sqs, config.executeUrl, setupMessage(run));
    const [setup] = await waitForResults(sqs, config.resultsUrl, [wantSetup(run)], deadline, deps);
    say(`SETUP: ${describeResult(setup)}`);
    if (setup?.type !== 'SETUP' || setup.outcome !== 'OK') return { passed: false, lines };

    const tests = await readTests(s3, config.bucket, run.testsKey);
    say(
      `tests.json has ${tests.length} tests: ${tests.map((t) => `${t.index}=${t.expected.slice(0, 12)}`).join(' ')}`,
    );
    const probe = probeFrom(tests);
    say(
      probe
        ? `Sandbox probe: cwd ${probe.cwd}, os.cpu_count ${probe.cpuCount}, usable CPUs ${probe.usableCpus}`
        : 'Sandbox probe: not found in tests.json',
    );

    for (const c of ANSWER_CASES) {
      await sendExecute(sqs, config.executeUrl, answerMessage(run, c));
    }
    say(
      `Sent ${ANSWER_CASES.length} ANSWER messages (${ANSWER_CASES.map((c) => c.name).join(', ')}).`,
    );
    const answers = await waitForResults(
      sqs,
      config.resultsUrl,
      ANSWER_CASES.map((c) => wantAnswer(run, c)),
      deadline,
      deps,
    );
    ANSWER_CASES.forEach((c, i) => say(`ANSWER ${c.name}: ${describeResult(answers[i])}`));

    passed = answers.every(isAllAccepted);
  } catch (error) {
    say(`ERROR: ${errorText(error)}`);
  } finally {
    const cleanup = await deleteRunFiles(s3, config.bucket, run.prefix);
    say(
      `Cleanup: deleted ${cleanup.deleted} object version(s) under ${run.prefix}` +
        (cleanup.problems.length ? `; PROBLEMS: ${cleanup.problems.join('; ')}` : '.'),
    );
    if (cleanup.problems.length) passed = false;
  }
  return { passed, lines };
}

async function main(): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error('Set AWS_PROFILE, e.g. AWS_PROFILE=dsa-judge pnpm smoke:worker');
  }
  const cfn = new CloudFormationClient({ region: REGION });
  const [data, queues, auth] = await Promise.all([
    stackOutputs(cfn, DATA_STACK),
    stackOutputs(cfn, QUEUES_STACK),
    stackOutputs(cfn, AUTH_STACK),
  ]);
  const bucket = requiredOutput(data, 'BucketName', DATA_STACK);
  const executeUrl = queueUrlFromOutputs(queues, 'execute');
  const resultsUrl = queueUrlFromOutputs(queues, 'results');

  console.log(`Profile ${profile}, bucket ${bucket}`);
  console.log(
    `Cognito login URL:\n  ${loginUrl(
      requiredOutput(auth, 'HostedUiBaseUrl', AUTH_STACK),
      requiredOutput(auth, 'UserPoolClientId', AUTH_STACK),
    )}\n`,
  );

  const outcome = await smoke(
    { s3: new S3Client({ region: REGION }), sqs: new SQSClient({ region: REGION }) },
    { bucket, executeUrl, resultsUrl },
  );
  console.log(outcome.passed ? 'PASS' : 'FAIL');
  if (!outcome.passed) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
