import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSetup, JobError, parseTestsFile } from './jobs.js';

const s3Mock = mockClient(S3Client);
const s3 = new S3Client({ region: 'ap-south-1' });

const tests = (n = 10) =>
  Array.from({ length: n }, (_, index) => ({
    index,
    kind: index < 7 ? 'small' : 'large',
    input: '{}',
    expected: '1',
  }));

describe('parseTestsFile', () => {
  it('accepts exactly 10 tests and returns them in index order', () => {
    const shuffled = [...tests()].reverse();
    expect(parseTestsFile(JSON.stringify({ tests: shuffled })).map((t) => t.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it.each([
    ['not JSON', 'nope'],
    ['no tests', JSON.stringify({})],
    ['9 tests', JSON.stringify({ tests: tests(9) })],
    ['11 tests', JSON.stringify({ tests: tests(11) })],
    ['a repeated index', JSON.stringify({ tests: [...tests(9), { ...tests()[0] }] })],
    [
      'an index out of range',
      JSON.stringify({ tests: [...tests(9), { ...tests()[0], index: 10 }] }),
    ],
    [
      'a bad kind',
      JSON.stringify({ tests: tests().map((t, i) => (i === 3 ? { ...t, kind: 'medium' } : t)) }),
    ],
    [
      'a missing expected output',
      JSON.stringify({
        tests: tests().map((t, i) => (i === 3 ? { ...t, expected: undefined } : t)),
      }),
    ],
  ])('rejects %s', (_label, text) => {
    expect(() => parseTestsFile(text)).toThrow(JobError);
  });
});

describe('handleSetup', () => {
  const msg = (overrides = {}) => ({
    type: 'SETUP',
    questionId: 'q1',
    version: 1,
    attempt: 1,
    referenceKey: 'questions/q1/v1/reference.py',
    generatorKey: 'questions/q1/v1/generator.py',
    smallInputs: Array.from({ length: 7 }, (_, i) => `{"n":${i}}`),
    largeInputCount: 3,
    testsKey: 'questions/q1/v1/tests.json',
    timeLimitMs: 1000,
    memoryMb: 128,
    compareMode: 'EXACT',
    ...overrides,
  });
  const text = (value) => ({ Body: { transformToString: async () => value } });
  const complete = () => ({ complete: true, failedInputIndexes: [], reasons: {}, tests: tests() });

  beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(GetObjectCommand, { Key: 'questions/q1/v1/reference.py' }).resolves(text('R'));
    s3Mock.on(GetObjectCommand, { Key: 'questions/q1/v1/generator.py' }).resolves(text('G'));
    s3Mock
      .on(GetObjectCommand, { Key: 'questions/q1/v1/small-inputs.json' })
      .resolves(text(JSON.stringify(msg().smallInputs)));
    s3Mock.on(PutObjectCommand).resolves({});
  });

  const run = (message, runSetup = vi.fn(async () => complete())) =>
    handleSetup(message, { s3, bucket: 'b', runSetup, slot: 2 }).then((out) => ({ out, runSetup }));

  it('runs setup in the given slot and writes the file', async () => {
    const { out, runSetup } = await run(msg());

    expect(runSetup.mock.calls[0][0].slot).toBe(2);
    expect(out.result.outcome).toBe('OK');
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('prefers small-inputs.json from S3 over the copy in the message', async () => {
    const stored = Array.from({ length: 7 }, (_, i) => `{"n":${i + 100}}`);
    s3Mock
      .on(GetObjectCommand, { Key: 'questions/q1/v1/small-inputs.json' })
      .resolves(text(JSON.stringify(stored)));

    const { runSetup } = await run(msg());

    expect(runSetup.mock.calls[0][0].smallInputs).toEqual(stored);
  });

  it('falls back to the message’s inputs only when the file is missing, not on other errors', async () => {
    s3Mock
      .on(GetObjectCommand, { Key: 'questions/q1/v1/small-inputs.json' })
      .rejects(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }));

    await expect(run(msg())).rejects.toThrow('Access Denied');
  });

  it.each([
    ['not a list', '{"a":1}'],
    ['a list of non-strings', '[1,2,3,4,5,6,7]'],
    ['the wrong number of inputs', JSON.stringify(['{}', '{}'])],
  ])('rejects a small-inputs.json that is %s', async (_label, body) => {
    s3Mock.on(GetObjectCommand, { Key: 'questions/q1/v1/small-inputs.json' }).resolves(text(body));
    await expect(run(msg())).rejects.toThrow(JobError);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it.each([
    ['a testsKey outside tests.json', { testsKey: 'questions/q1/v1/reference.py' }],
    ['a testsKey with a path escape', { testsKey: 'questions/../answers/v1/tests.json' }],
    ['a testsKey with extra folders', { testsKey: 'questions/q1/v1/extra/tests.json' }],
    ['too few inputs', { largeInputCount: 2 }],
    ['too many inputs', { largeInputCount: 4 }],
  ])('rejects %s before doing any work', async (_label, overrides) => {
    const runSetup = vi.fn();
    await expect(run(msg(overrides), runSetup)).rejects.toThrow(JobError);
    expect(runSetup).not.toHaveBeenCalled();
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('writes tests.json only at the message’s testsKey, with the question and version', async () => {
    await run(msg({ version: 3, testsKey: 'questions/q1/v3/tests.json' }));
    const [put] = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
    expect(put.Key).toBe('questions/q1/v3/tests.json');
    expect(JSON.parse(put.Body)).toMatchObject({ questionId: 'q1', version: 3 });
    expect(put.ContentType).toBe('application/json');
  });
});
