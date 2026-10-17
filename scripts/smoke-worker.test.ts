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
} from '@aws-sdk/client-sqs';
import { executeMsg, resultMsg, type ResultMsg } from '@yulove/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANSWER_CASES,
  CPP_DRIVER,
  CPP_STUDENT_CODE,
  GENERATOR_PY,
  PYTHON_DRIVER,
  PYTHON_STUDENT_CODE,
  QUESTION_ID,
  REFERENCE_PY,
  answerMessage,
  deleteRunFiles,
  describeResult,
  fifoIds,
  isAllAccepted,
  loginUrl,
  newRun,
  probeFrom,
  queueUrlFromOutputs,
  setupMessage,
  smallInputs,
  smoke,
  stackOutputs,
  wantAnswer,
  wantSetup,
  waitForResults,
} from './smoke-worker.js';

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const cfnMock = mockClient(CloudFormationClient);
const s3 = new S3Client({ region: 'ap-south-1' });
const sqs = new SQSClient({ region: 'ap-south-1' });
const cfn = new CloudFormationClient({ region: 'ap-south-1' });

const run = newRun(new Date('2026-10-17T10:00:00Z'));
const EXECUTE = 'https://sqs.ap-south-1.amazonaws.com/123456789012/execute.fifo';
const RESULTS = 'https://sqs.ap-south-1.amazonaws.com/123456789012/results.fifo';
const BUCKET = 'bucket';

beforeEach(() => {
  s3Mock.reset();
  sqsMock.reset();
  cfnMock.reset();
});

describe('the run', () => {
  it('lives under questions/smoke/v<unix seconds>/, which the worker may read and write', () => {
    expect(run.version).toBe(1792231200);
    expect(run.prefix).toBe('questions/smoke/v1792231200/');
    expect(run.testsKey).toMatch(/^questions\/[^/]+\/v\d+\/tests\.json$/);
    expect(run.examId).toBe('smoke-1792231200');
  });

  it('is different every second, so FIFO ids never repeat across runs', () => {
    const later = newRun(new Date('2026-10-17T10:00:01Z'));
    expect(fifoIds(setupMessage(later)).deduplicationId).not.toBe(
      fifoIds(setupMessage(run)).deduplicationId,
    );
  });
});

describe('messages', () => {
  it('builds a valid SETUP: 7 small inputs, 3 large, tests.json next to the reference', () => {
    const msg = setupMessage(run);
    expect(executeMsg.safeParse(msg).success).toBe(true);
    expect(msg).toMatchObject({
      type: 'SETUP',
      questionId: QUESTION_ID,
      version: run.version,
      largeInputCount: 3,
      referenceKey: `${run.prefix}reference.py`,
      generatorKey: `${run.prefix}generator.py`,
      testsKey: `${run.prefix}tests.json`,
    });
    expect(msg.type === 'SETUP' && msg.smallInputs).toHaveLength(7);
  });

  it.each(ANSWER_CASES.map((c) => [c.name, c] as const))(
    "builds a valid %s ANSWER that points at the SETUP's tests.json",
    (_name, c) => {
      const msg = answerMessage(run, c);
      expect(executeMsg.safeParse(msg).success).toBe(true);
      expect(msg).toMatchObject({ type: 'ANSWER', testsKey: run.testsKey, examId: run.examId });
      expect(msg.type === 'ANSWER' && msg.driverCode).toContain(c.correctedCode);
    },
  );

  it('uses distinct FIFO groups and dedup ids for the setup and each answer', () => {
    const all = [setupMessage(run), ...ANSWER_CASES.map((c) => answerMessage(run, c))].map(fifoIds);
    expect(new Set(all.map((i) => i.groupId)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.deduplicationId)).size).toBe(all.length);
    for (const ids of all) expect(ids.deduplicationId.length).toBeLessThanOrEqual(128);
  });

  it('copies the student code into each driver unchanged', () => {
    expect(PYTHON_DRIVER).toContain(PYTHON_STUDENT_CODE);
    expect(CPP_DRIVER).toContain(CPP_STUDENT_CODE);
    expect(CPP_DRIVER.startsWith('#include <nlohmann/json.hpp>')).toBe(true);
  });
});

describe('the fixture programs follow the input/output convention', () => {
  const python = spawnSync('python3', ['--version']).status === 0;
  const runPython = (source: string, args: string[], stdin: string) =>
    spawnSync('python3', ['-c', source, ...args], { input: stdin, encoding: 'utf8' });

  it('has seven small inputs, each a JSON object with nums', () => {
    const inputs = smallInputs();
    expect(inputs).toHaveLength(7);
    for (const text of inputs) {
      expect(Array.isArray((JSON.parse(text) as { nums: unknown }).nums)).toBe(true);
    }
  });

  it.runIf(python)('reference.py prints the sum as one line of JSON', () => {
    const out = runPython(REFERENCE_PY, [], '{"nums":[1,2,3,4],"probe":{}}');
    expect(out.stdout).toBe('10\n');
  });

  it.runIf(python)('the Python driver gives the same answer as the reference', () => {
    for (const input of smallInputs()) {
      const expected = runPython(REFERENCE_PY, [], input).stdout;
      expect(runPython(PYTHON_DRIVER, [], input).stdout).toBe(expected);
    }
  });

  it.runIf(python)(
    'generator.py prints one JSON object per call, with a probe on the first',
    () => {
      const outputs = [0, 1, 2].map((i) => runPython(GENERATOR_PY, [String(i)], ''));
      for (const out of outputs) {
        expect(out.status).toBe(0);
        expect(out.stdout.trim().split('\n')).toHaveLength(1);
      }
      const first = JSON.parse(outputs[0]?.stdout ?? '') as { nums: number[]; probe: object };
      expect(first.probe).toMatchObject({
        cwd: expect.any(String),
        cpuCount: expect.any(Number),
        usableCpus: expect.any(Number),
      });
      expect(JSON.parse(outputs[1]?.stdout ?? '')).not.toHaveProperty('probe');
      expect(first.nums.length).toBe(1000);
    },
  );
});

describe('stack outputs', () => {
  it('reads outputs into a map', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: 'S',
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: new Date(),
          Outputs: [
            { OutputKey: 'A', OutputValue: '1' },
            { OutputKey: 'B', OutputValue: '2' },
          ],
        },
      ],
    });
    await expect(stackOutputs(cfn, 'S')).resolves.toEqual({ A: '1', B: '2' });
  });

  it('finds a queue URL by its value, whatever the generated output name', () => {
    const outputs = {
      ExportsOutputRefexecuteQueueE41478D938665226: EXECUTE,
      ExportsOutputFnGetAttexecuteQueueE41478D9Arn7F173581:
        'arn:aws:sqs:ap-south-1:123456789012:execute.fifo',
      ExportsOutputRefresultsQueue3CC3E037F080A110: RESULTS,
    };
    expect(queueUrlFromOutputs(outputs, 'execute')).toBe(EXECUTE);
    expect(queueUrlFromOutputs(outputs, 'results')).toBe(RESULTS);
    expect(() => queueUrlFromOutputs(outputs, 'transcribe')).toThrow(/transcribe\.fifo/);
  });
});

describe('loginUrl', () => {
  const url = new URL(
    loginUrl('https://dsa-judge-1.auth.ap-south-1.amazoncognito.com/', 'client1'),
  );

  it('is the hosted UI authorize endpoint for the authorization code flow', () => {
    expect(url.origin + url.pathname).toBe(
      'https://dsa-judge-1.auth.ap-south-1.amazoncognito.com/oauth2/authorize',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client1');
  });

  it('asks for openid email profile and redirects to the local callback', () => {
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
    expect(url.searchParams.get('identity_provider')).toBe('Google');
  });
});

// A results queue that returns the given bodies one receive at a time.
function queueReturns(...batches: Array<unknown[]>) {
  const receive = sqsMock.on(ReceiveMessageCommand);
  batches.forEach((batch, i) => {
    receive.resolvesOnce({
      Messages: batch.map((body, k) => ({
        Body: JSON.stringify(body),
        ReceiptHandle: `h${i}-${k}`,
      })),
    });
  });
  receive.resolves({});
}

const setupOk: ResultMsg = {
  type: 'SETUP',
  questionId: QUESTION_ID,
  version: run.version,
  attempt: 1,
  outcome: 'OK',
  testsKey: run.testsKey,
  testCount: 10,
};

function answerResult(c: (typeof ANSWER_CASES)[number], verdict = 'AC'): ResultMsg {
  return {
    type: 'ANSWER',
    examId: run.examId,
    studentEmail: c.studentEmail,
    questionNumber: c.questionNumber,
    attempt: 1,
    outcome: 'COMPLETED',
    verdicts: Array.from({ length: 10 }, (_, index) => ({
      index,
      kind: index < 7 ? ('small' as const) : ('large' as const),
      verdict: verdict as 'AC',
    })),
  };
}

describe('waitForResults', () => {
  const FAR = Date.now() + 10 * 60_000;

  it('returns the wanted result and deletes only that message', async () => {
    queueReturns([setupOk]);
    const [found] = await waitForResults(sqs, RESULTS, [wantSetup(run)], FAR);

    expect(found).toEqual(setupOk);
    expect(sqsMock.commandCalls(DeleteMessageCommand).map((c) => c.args[0].input)).toEqual([
      { QueueUrl: RESULTS, ReceiptHandle: 'h0-0' },
    ]);
  });

  it('gives other messages straight back and never deletes them', async () => {
    const someoneElses = { ...setupOk, questionId: 'q-real', version: 3 };
    queueReturns([someoneElses, 'not a result', { type: 'NOPE' }], [setupOk]);

    const [found] = await waitForResults(sqs, RESULTS, [wantSetup(run)], FAR);

    expect(found).toEqual(setupOk);
    const released = sqsMock
      .commandCalls(ChangeMessageVisibilityCommand)
      .map((c) => c.args[0].input);
    expect(released).toHaveLength(3);
    expect(released.every((r) => r.VisibilityTimeout === 0)).toBe(true);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });

  it('matches answers to their own student and question, in the order asked', async () => {
    const [py, cpp] = ANSWER_CASES;
    queueReturns([answerResult(cpp!)], [answerResult(py!)]);

    const found = await waitForResults(
      sqs,
      RESULTS,
      [wantAnswer(run, py!), wantAnswer(run, cpp!)],
      FAR,
    );

    expect(found.map((r) => r?.type === 'ANSWER' && r.studentEmail)).toEqual([
      py!.studentEmail,
      cpp!.studentEmail,
    ]);
  });

  it('ignores results of an earlier run', async () => {
    const old = newRun(new Date('2026-10-16T10:00:00Z'));
    queueReturns([{ ...setupOk, version: old.version }], [setupOk]);

    const [found] = await waitForResults(sqs, RESULTS, [wantSetup(run)], FAR);
    expect(found).toEqual(setupOk);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });

  it('gives up at the deadline and reports what is missing', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});
    let t = 0;
    const found = await waitForResults(sqs, RESULTS, [wantSetup(run)], 100, {
      now: () => (t += 40),
    });

    expect(found).toEqual([undefined]);
    expect(sqsMock.commandCalls(ReceiveMessageCommand).length).toBeGreaterThan(0);
    expect(sqsMock.commandCalls(ReceiveMessageCommand).length).toBeLessThan(5);
  });
});

describe('describing results', () => {
  it('summarises verdicts', () => {
    const [py] = ANSWER_CASES;
    expect(describeResult(answerResult(py!))).toBe('COMPLETED: AC×10');
    expect(isAllAccepted(answerResult(py!))).toBe(true);
    expect(isAllAccepted(answerResult(py!, 'WA'))).toBe(false);
    expect(isAllAccepted(undefined)).toBe(false);
  });

  it('explains failures and missing results', () => {
    expect(describeResult(undefined)).toMatch(/no result/);
    expect(describeResult(setupOk)).toMatch(/OK, 10 tests/);
    expect(
      describeResult({
        type: 'SETUP',
        questionId: 'smoke',
        version: 1,
        attempt: 1,
        outcome: 'REFERENCE_FAILED',
        failedInputIndexes: [2, 8],
        reason: 'crashed',
      }),
    ).toBe('REFERENCE_FAILED on inputs 2, 8: crashed');
    expect(
      describeResult({
        ...answerResult(ANSWER_CASES[0]!),
        outcome: 'FAILED',
        failReason: 'WORKER_ERROR',
        detail: 'boom',
      } as unknown as ResultMsg),
    ).toBe('FAILED (WORKER_ERROR): boom');
  });

  it('reads the probe out of the stored tests', () => {
    const tests = [
      { index: 0, kind: 'small', input: '{"nums":[]}', expected: '0' },
      {
        index: 7,
        kind: 'large',
        input: '{"nums":[1],"probe":{"cwd":"/work/slot1/run-1","cpuCount":4,"usableCpus":4}}',
        expected: '1',
      },
    ];
    expect(probeFrom(tests)).toEqual({ cwd: '/work/slot1/run-1', cpuCount: 4, usableCpus: 4 });
    expect(probeFrom(tests.slice(0, 1))).toBeUndefined();
  });
});

describe('deleteRunFiles', () => {
  const PREFIX = run.prefix;

  it('deletes every version and delete marker under the prefix, following pages', async () => {
    s3Mock
      .on(ListObjectVersionsCommand)
      .resolvesOnce({
        Versions: [{ Key: `${PREFIX}reference.py`, VersionId: 'v1' }],
        DeleteMarkers: [{ Key: `${PREFIX}tests.json`, VersionId: 'm1' }],
        IsTruncated: true,
        NextKeyMarker: `${PREFIX}tests.json`,
        NextVersionIdMarker: 'm1',
      })
      .resolvesOnce({ Versions: [{ Key: `${PREFIX}tests.json`, VersionId: 'v2' }] });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const report = await deleteRunFiles(s3, BUCKET, PREFIX);

    expect(report).toEqual({ deleted: 3, problems: [] });
    const input = s3Mock.commandCalls(DeleteObjectsCommand)[0]?.args[0].input;
    expect(input?.Delete?.Objects).toEqual([
      { Key: `${PREFIX}reference.py`, VersionId: 'v1' },
      { Key: `${PREFIX}tests.json`, VersionId: 'm1' },
      { Key: `${PREFIX}tests.json`, VersionId: 'v2' },
    ]);
    expect(s3Mock.commandCalls(ListObjectVersionsCommand)[1]?.args[0].input).toMatchObject({
      KeyMarker: `${PREFIX}tests.json`,
      VersionIdMarker: 'm1',
    });
  });

  it('never deletes anything outside the prefix', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [
        { Key: `${PREFIX}reference.py`, VersionId: 'v1' },
        { Key: 'questions/smoke/v1/reference.py', VersionId: 'other' },
        { Key: 'questions/real/v1/tests.json', VersionId: 'real' },
      ],
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await deleteRunFiles(s3, BUCKET, PREFIX);

    const keys = s3Mock
      .commandCalls(DeleteObjectsCommand)
      .flatMap((c) => c.args[0].input.Delete?.Objects ?? [])
      .map((o) => o.Key);
    expect(keys).toEqual([`${PREFIX}reference.py`]);
  });

  it('falls back to a plain delete when versions cannot be deleted, and says what remains', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: `${PREFIX}reference.py`, VersionId: 'v1' }],
    });
    s3Mock
      .on(DeleteObjectsCommand)
      .resolvesOnce({
        Errors: [{ Key: `${PREFIX}reference.py`, VersionId: 'v1', Code: 'AccessDenied' }],
      })
      .resolvesOnce({});

    const report = await deleteRunFiles(s3, BUCKET, PREFIX);

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/old versions .* remain/);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)[1]?.args[0].input.Delete?.Objects).toEqual([
      { Key: `${PREFIX}reference.py` },
    ]);
  });

  it('reports a listing failure instead of throwing', async () => {
    s3Mock.on(ListObjectVersionsCommand).rejects(new Error('AccessDenied'));

    const report = await deleteRunFiles(s3, BUCKET, PREFIX);
    expect(report.problems[0]).toMatch(/could not list .*AccessDenied/);
  });
});

describe('smoke', () => {
  const config = { bucket: BUCKET, executeUrl: EXECUTE, resultsUrl: RESULTS };
  const testsJson = JSON.stringify({
    questionId: QUESTION_ID,
    version: run.version,
    tests: Array.from({ length: 10 }, (_, index) => ({
      index,
      kind: index < 7 ? 'small' : 'large',
      input:
        index === 7
          ? '{"nums":[1],"probe":{"cwd":"/work/x","cpuCount":4,"usableCpus":4}}'
          : '{"nums":[1]}',
      expected: '1',
    })),
  });

  function healthyAws(verdict = 'AC') {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: async () => testsJson } as never,
    });
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: run.testsKey, VersionId: 'v1' }],
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});
    queueReturns(
      [setupOk],
      [answerResult(ANSWER_CASES[0]!, verdict), answerResult(ANSWER_CASES[1]!, verdict)],
    );
  }

  it('passes when the setup works and both answers are accepted, and cleans up', async () => {
    healthyAws();
    const lines: string[] = [];

    const outcome = await smoke({ s3, sqs }, config, (l) => lines.push(l), { run });

    expect(outcome.passed).toBe(true);
    expect(lines.join('\n')).toMatch(/SETUP: OK, 10 tests/);
    expect(lines.join('\n')).toMatch(/Sandbox probe: cwd \/work\/x, os.cpu_count 4, usable CPUs 4/);
    expect(lines.join('\n')).toMatch(/ANSWER Python: COMPLETED: AC×10/);
    expect(lines.join('\n')).toMatch(/ANSWER C\+\+: COMPLETED: AC×10/);

    const sent = sqsMock.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
    expect(sent.map((s) => JSON.parse(s.MessageBody ?? '').type)).toEqual([
      'SETUP',
      'ANSWER',
      'ANSWER',
    ]);
    expect(sent.every((s) => s.QueueUrl === EXECUTE)).toBe(true);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(3);
  });

  it('sends the answers only after the setup result has arrived', async () => {
    healthyAws();
    const order: string[] = [];
    sqsMock.on(SendMessageCommand).callsFake((input) => {
      order.push(`send ${JSON.parse(input.MessageBody).type}`);
      return {};
    });
    sqsMock.on(DeleteMessageCommand).callsFake(() => {
      order.push('delete');
      return {};
    });

    await smoke({ s3, sqs }, config, () => undefined, { run });

    expect(order).toEqual([
      'send SETUP',
      'delete',
      'send ANSWER',
      'send ANSWER',
      'delete',
      'delete',
    ]);
  });

  it('fails, without sending answers, when the setup fails; still cleans up', async () => {
    healthyAws();
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          ReceiptHandle: 'h',
          Body: JSON.stringify({
            type: 'SETUP',
            questionId: QUESTION_ID,
            version: run.version,
            attempt: 1,
            outcome: 'FAILED',
            reason: 'storage broke',
          }),
        },
      ],
    });

    const lines: string[] = [];
    const outcome = await smoke({ s3, sqs }, config, (l) => lines.push(l), { run });

    expect(outcome.passed).toBe(false);
    expect(lines.join('\n')).toMatch(/SETUP: FAILED: storage broke/);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
  });

  it('fails when an answer is not accepted', async () => {
    healthyAws('WA');
    const outcome = await smoke({ s3, sqs }, config, () => undefined, { run });
    expect(outcome.passed).toBe(false);
  });

  it('fails on timeout and still cleans up', async () => {
    healthyAws();
    sqsMock.on(ReceiveMessageCommand).resolves({});
    let t = Date.now();
    const lines: string[] = [];

    const outcome = await smoke({ s3, sqs }, config, (l) => lines.push(l), {
      run,
      now: () => (t += 4 * 60_000),
    });

    expect(outcome.passed).toBe(false);
    expect(lines.join('\n')).toMatch(/SETUP: no result before the deadline/);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
  });

  it('cleans up even if sending fails', async () => {
    healthyAws();
    sqsMock.on(SendMessageCommand).rejects(new Error('AccessDenied'));

    const lines: string[] = [];
    const outcome = await smoke({ s3, sqs }, config, (l) => lines.push(l), { run });

    expect(outcome.passed).toBe(false);
    expect(lines.join('\n')).toMatch(/ERROR: AccessDenied/);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
  });

  it('only accepts messages the shared schema accepts', () => {
    expect(resultMsg.safeParse(setupOk).success).toBe(true);
  });
});

describe('running the script', () => {
  it('refuses to start without AWS_PROFILE, before touching AWS', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'smoke-worker.ts'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
