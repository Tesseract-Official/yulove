import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { QuestionItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import {
  OTHER_TEACHER,
  questionItem,
  seedPeople,
  signature,
  TEACHER,
} from '../test-utils/questions.js';
import { handler, PREVIEW_CHARS } from './get-question-tests.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);

const call = (email: string, id = 'q1') =>
  invoke(
    handler,
    makeEvent({
      method: 'GET',
      path: `/questions/${id}/tests`,
      email,
      pathParameters: { id },
    }),
  );

const testsFile = (overrides: Record<number, { input?: string; expected?: string }> = {}) => ({
  questionId: 'q1',
  version: 1,
  tests: Array.from({ length: 10 }, (_, index) => ({
    index,
    kind: index < 7 ? 'small' : 'large',
    input: overrides[index]?.input ?? `{"n":${index}}`,
    expected: overrides[index]?.expected ?? `${index * 2}`,
  })),
});

function serve(key: string, file: unknown) {
  s3.on(GetObjectCommand, { Bucket: 'bucket', Key: key }).resolves({
    Body: { transformToString: async () => JSON.stringify(file) } as never,
  });
}

const reviewable = (extra: Partial<QuestionItem> = {}) =>
  questionItem({ testStatus: 'NEEDS_REVIEW', signature, testCount: 10, testAttempt: 1, ...extra });

beforeEach(() => {
  db.reset();
  s3.reset();
  process.env['BUCKET_NAME'] = 'bucket';
  db.addBatch('A');
  seedPeople(db);
});

describe('GET /questions/{id}/tests', () => {
  it('returns the signature and all 10 tests once the question awaits review', async () => {
    db.put('Questions', reviewable());
    serve('questions/q1/v1/tests.json', testsFile());

    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      questionId: 'q1',
      version: 1,
      testStatus: 'NEEDS_REVIEW',
      signature,
    });
    expect(body.tests).toHaveLength(10);
    expect(body.tests[0]).toEqual({
      index: 0,
      kind: 'small',
      input: '{"n":0}',
      expected: '0',
      truncated: false,
    });
    expect(body.tests[7]).toMatchObject({ index: 7, kind: 'large' });
    expect(body.tests.filter((t: { kind: string }) => t.kind === 'small')).toHaveLength(7);
    expect(body.tests.filter((t: { kind: string }) => t.kind === 'large')).toHaveLength(3);
  });

  it('also returns the tests after approval', async () => {
    db.put('Questions', reviewable({ testStatus: 'APPROVED' }));
    serve('questions/q1/v1/tests.json', testsFile());

    const { body } = await call(TEACHER);

    expect(body.testStatus).toBe('APPROVED');
    expect(body.tests).toHaveLength(10);
  });

  it('cuts large inputs and outputs to a preview and says so', async () => {
    db.put('Questions', reviewable());
    const huge = 'x'.repeat(PREVIEW_CHARS * 50);
    serve('questions/q1/v1/tests.json', testsFile({ 8: { input: huge }, 9: { expected: huge } }));

    const { body } = await call(TEACHER);

    expect(body.tests[8].input).toHaveLength(PREVIEW_CHARS);
    expect(body.tests[8].truncated).toBe(true);
    expect(body.tests[9].expected).toHaveLength(PREVIEW_CHARS);
    expect(body.tests[9].truncated).toBe(true);
    expect(body.tests[0].truncated).toBe(false);
    expect(JSON.stringify(body).length).toBeLessThan(PREVIEW_CHARS * 20);
  });

  it('reads the tests from testsKey when the question points at another version’s file', async () => {
    db.put('Questions', reviewable({ version: 2, testsKey: 'questions/q1/v1/tests.json' }));
    serve('questions/q1/v1/tests.json', testsFile());

    const { body } = await call(TEACHER);

    expect(body.version).toBe(2);
    expect(body.tests).toHaveLength(10);
  });

  it('returns only the status when tests.json does not exist yet', async () => {
    db.put('Questions', reviewable());
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));

    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(body.testStatus).toBe('NEEDS_REVIEW');
    expect(body).not.toHaveProperty('tests');
  });

  it.each(['GENERATING', 'GENERATION_FAILED', undefined] as const)(
    'returns only the status when the question is %s, without reading S3',
    async (state) => {
      db.put(
        'Questions',
        questionItem({
          ...(state ? { testStatus: state } : {}),
          ...(state === 'GENERATION_FAILED'
            ? { testFailure: 'Gemini returned 6 small inputs' }
            : {}),
        }),
      );

      const { status, body } = await call(TEACHER);

      expect(status).toBe(200);
      expect(body.testStatus).toBe(state ?? null);
      expect(body.signature).toBeNull();
      expect(body).not.toHaveProperty('tests');
      expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
      if (state === 'GENERATION_FAILED')
        expect(body.testFailure).toBe('Gemini returned 6 small inputs');
    },
  );

  it('does not show an older tests.json while a new round is generating', async () => {
    db.put('Questions', reviewable({ testStatus: 'GENERATING' }));
    serve('questions/q1/v1/tests.json', testsFile());

    const { body } = await call(TEACHER);

    expect(body).not.toHaveProperty('tests');
  });

  it('lets a super admin read any question', async () => {
    db.put('Questions', reviewable());
    serve('questions/q1/v1/tests.json', testsFile());
    expect((await call('super-admin@college.edu')).body.tests).toHaveLength(10);
  });

  it.each(deniedRoles('TEACHER'))('refuses a %s with 403', async (role) => {
    db.put('Questions', reviewable());
    expect((await call(userOf(role).email)).status).toBe(403);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("refuses another teacher's question with 403 and never reads their tests", async () => {
    db.put('Questions', reviewable());
    serve('questions/q1/v1/tests.json', testsFile());

    const { status, body } = await call(OTHER_TEACHER);

    expect(status).toBe(403);
    expect(JSON.stringify(body)).not.toContain('"n":');
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('answers 404 for an unknown question', async () => {
    expect((await call(TEACHER, 'nope')).status).toBe(404);
  });
});
