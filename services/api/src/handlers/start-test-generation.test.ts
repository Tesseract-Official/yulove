import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { QuestionItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { OTHER_TEACHER, questionItem, seedPeople, TEACHER } from '../test-utils/questions.js';
import { handler } from './start-test-generation.js';

const db = new FakeDb();
const lambda = mockClient(LambdaClient);

const call = (email: string, id = 'q1') =>
  invoke(
    handler,
    makeEvent({
      method: 'POST',
      path: `/questions/${id}/generate-tests`,
      email,
      pathParameters: { id },
    }),
  );

const stored = () => db.get<QuestionItem>('Questions', { questionId: 'q1', version: 1 });

beforeEach(() => {
  db.reset();
  lambda.reset();
  lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
  process.env['TESTGEN_FUNCTION_NAME'] = 'test-gen-fn';
  db.addBatch('A');
  seedPeople(db);
  db.put('Questions', questionItem());
});

describe('POST /questions/{id}/generate-tests', () => {
  it('marks the question GENERATING and invokes the Lambda asynchronously', async () => {
    const { status, body } = await call(TEACHER);

    expect(status).toBe(202);
    expect(body).toEqual({ questionId: 'q1', version: 1, testStatus: 'GENERATING', attempt: 1 });
    expect(stored()).toMatchObject({ testStatus: 'GENERATING', testAttempt: 1 });

    const calls = lambda.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.FunctionName).toBe('test-gen-fn');
    expect(input?.InvocationType).toBe('Event');
    expect(JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array))).toEqual({
      mode: 'generate',
      questionId: 'q1',
      version: 1,
      attempt: 1,
    });
  });

  it('counts a new round every time, and works from any state', async () => {
    for (const state of ['NEEDS_REVIEW', 'APPROVED', 'GENERATION_FAILED', 'GENERATING'] as const) {
      db.put('Questions', questionItem({ testStatus: state, testAttempt: 4, testFailure: 'old' }));

      const { status, body } = await call(TEACHER);

      expect(status, state).toBe(202);
      expect(body.attempt, state).toBe(5);
      expect(stored()?.testFailure).toBeUndefined();
    }
  });

  it('lets a super admin start generation for any question', async () => {
    expect((await call('super-admin@college.edu')).status).toBe(202);
  });

  it.each(deniedRoles('TEACHER'))(
    'refuses a %s with 403, without invoking anything',
    async (role) => {
      expect((await call(userOf(role).email)).status).toBe(403);
      expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
      expect(stored()?.testStatus).toBeUndefined();
    },
  );

  it("refuses another teacher's question with 403, without invoking anything", async () => {
    expect((await call(OTHER_TEACHER)).status).toBe(403);
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(stored()?.testStatus).toBeUndefined();
  });

  it('answers 404 for an unknown question', async () => {
    expect((await call(TEACHER, 'nope')).status).toBe(404);
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('answers 409 once an exam using this version has an answer, and does nothing', async () => {
    db.put('Exams', {
      examId: 'e1',
      batchId: 'A',
      title: 'W1',
      date: '2026-10-24',
      status: 'READY',
      questions: [{ number: 1, questionId: 'q1', version: 1, marks: 10 }],
    });
    db.put('Answers', {
      examStudent: 'e1#s1@college.edu',
      questionNumber: 1,
      attempt: 1,
      status: 'QUEUED',
    });
    db.put('Questions', questionItem({ testStatus: 'APPROVED', testAttempt: 2 }));

    const { status, body } = await call(TEACHER);

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/new version/);
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(stored()).toMatchObject({ testStatus: 'APPROVED', testAttempt: 2 });
  });

  it('marks the question GENERATION_FAILED and reports the error when the invoke fails', async () => {
    lambda.on(InvokeCommand).rejects(new Error('AccessDenied'));

    const { status } = await call(TEACHER);

    expect(status).toBe(500);
    expect(stored()).toMatchObject({ testStatus: 'GENERATION_FAILED' });
    expect(stored()?.testFailure).toMatch(/Could not start/);
  });

  it('treats an unexpected invoke status as a failure', async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 200 });

    expect((await call(TEACHER)).status).toBe(500);
    expect(stored()?.testStatus).toBe('GENERATION_FAILED');
  });
});
