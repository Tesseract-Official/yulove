import type { QuestionItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import {
  OTHER_TEACHER,
  questionContent,
  questionItem,
  seedPeople,
  signature,
  TEACHER,
} from '../test-utils/questions.js';
import { handler } from './update-question.js';

const db = new FakeDb();
const call = (email: string, id: string, body: unknown) =>
  invoke(
    handler,
    makeEvent({
      method: 'PUT',
      path: `/questions/${id}`,
      email,
      pathParameters: { id },
      body,
    }),
  );

const stored = (version = 1) => db.get<QuestionItem>('Questions', { questionId: 'q1', version });

const withTests = (status: QuestionItem['testStatus'] = 'APPROVED') =>
  questionItem({
    testStatus: status,
    testCount: 10,
    testsKey: 'questions/q1/v1/tests.json',
    testAttempt: 2,
    signature,
  });

/** An exam for batch A that uses q1 v1, with one student who has submitted an answer. */
function freezeQuestion(version = 1) {
  db.put('Exams', {
    examId: 'e1',
    batchId: 'A',
    title: 'Week 1',
    date: '2026-10-24',
    status: 'READY',
    questions: [{ number: 1, questionId: 'q1', version, marks: 10 }],
  });
  db.put('Answers', {
    examStudent: 'e1#s1@college.edu',
    questionNumber: 1,
    attempt: 1,
    status: 'QUEUED',
  });
}

beforeEach(() => {
  db.reset();
  db.addBatch('A');
  seedPeople(db);
});

describe('PUT /questions/{id}: not yet used', () => {
  beforeEach(() => db.put('Questions', withTests()));

  it('edits in place', async () => {
    const { status, body } = await call(TEACHER, 'q1', { ...questionContent, title: 'Two Sum II' });

    expect(status).toBe(200);
    expect(body.newVersion).toBe(false);
    expect(body.question.version).toBe(1);
    expect(stored()?.title).toBe('Two Sum II');
    expect(db.all('Questions')).toHaveLength(1);
  });

  it('keeps the tests and approval when only the title and examples change', async () => {
    const { body } = await call(TEACHER, 'q1', {
      ...questionContent,
      title: 'New title',
      examples: [{ input: '[1,2] 3', output: '[0,1]' }],
    });

    expect(body.testsKept).toBe(true);
    expect(stored()).toMatchObject({
      title: 'New title',
      examples: [{ input: '[1,2] 3', output: '[0,1]' }],
      testStatus: 'APPROVED',
      testCount: 10,
      testsKey: 'questions/q1/v1/tests.json',
      testAttempt: 2,
      signature,
    });
  });

  it.each([
    ['statement', { statement: 'A different problem' }],
    ['ioDescription', { ioDescription: 'Different I/O' }],
    ['constraints', { constraints: '1 <= n <= 10' }],
    ['targetComplexity', { targetComplexity: 'O(n log n)' }],
    ['timeLimitMs', { timeLimitMs: 3000 }],
    ['memoryMb', { memoryMb: 512 }],
    ['compareMode', { compareMode: 'ANY_ORDER' as const }],
  ])('throws the tests away when %s changes', async (_field, change) => {
    const { status, body } = await call(TEACHER, 'q1', { ...questionContent, ...change });

    expect(status).toBe(200);
    expect(body.testsKept).toBe(false);
    const item = stored();
    for (const field of ['testStatus', 'testCount', 'testsKey', 'signature'] as const) {
      expect(item?.[field], field).toBeUndefined();
    }
    // The round moves on, so a generation still running for the old content goes stale.
    expect(item?.testAttempt).toBe(3);
    expect(item).toMatchObject(change);
  });

  it('works on a question with no tests yet', async () => {
    db.put('Questions', questionItem());
    const { status } = await call(TEACHER, 'q1', { ...questionContent, statement: 'New' });
    expect(status).toBe(200);
    expect(stored()?.statement).toBe('New');
  });

  it('ignores answers and exams that belong to other question versions', async () => {
    freezeQuestion(7);
    expect((await call(TEACHER, 'q1', questionContent)).body.newVersion).toBe(false);
  });
});

describe('PUT /questions/{id}: versioning when the question is in use', () => {
  beforeEach(() => {
    db.put('Questions', withTests());
    freezeQuestion();
  });

  it('creates version 2 and leaves version 1 untouched', async () => {
    const before = structuredClone(stored());

    const { status, body } = await call(TEACHER, 'q1', {
      ...questionContent,
      statement: 'Reworded problem',
    });

    expect(status).toBe(201);
    expect(body.newVersion).toBe(true);
    expect(body.question).toMatchObject({
      questionId: 'q1',
      version: 2,
      statement: 'Reworded problem',
      teacherEmail: TEACHER,
    });
    expect(stored(1)).toEqual(before);
    expect(stored(2)?.statement).toBe('Reworded problem');
  });

  it('starts version 2 without tests when the content changed', async () => {
    await call(TEACHER, 'q1', { ...questionContent, timeLimitMs: 5000 });

    const v2 = stored(2);
    expect(v2?.testStatus).toBeUndefined();
    expect(v2?.signature).toBeUndefined();
    expect(v2?.testsKey).toBeUndefined();
  });

  it('lets version 2 reuse the tests when only the title or examples changed', async () => {
    const { body } = await call(TEACHER, 'q1', { ...questionContent, title: 'Retitled' });

    expect(body.testsKept).toBe(true);
    expect(stored(2)).toMatchObject({
      title: 'Retitled',
      testStatus: 'APPROVED',
      testCount: 10,
      testsKey: 'questions/q1/v1/tests.json',
      signature,
    });
  });

  it('does not inherit a half-finished generation', async () => {
    db.put('Questions', withTests('GENERATING'));
    await call(TEACHER, 'q1', { ...questionContent, title: 'Retitled' });
    expect(stored(2)?.testStatus).toBeUndefined();
  });

  it('keeps the original owner when a super admin edits', async () => {
    const { body } = await call('super-admin@college.edu', 'q1', {
      ...questionContent,
      statement: 'Admin fix',
    });
    expect(body.question.teacherEmail).toBe(TEACHER);
    expect(stored(2)?.teacherEmail).toBe(TEACHER);
  });

  it('edits version 2 in place once version 2 itself is unused', async () => {
    await call(TEACHER, 'q1', { ...questionContent, statement: 'v2 text' });
    const { status, body } = await call(TEACHER, 'q1', {
      ...questionContent,
      statement: 'v2 edited',
    });

    expect(status).toBe(200);
    expect(body.question.version).toBe(2);
    expect(stored(2)?.statement).toBe('v2 edited');
    expect(db.all('Questions')).toHaveLength(2);
  });

  it('creates version 3 when version 2 is also in use', async () => {
    await call(TEACHER, 'q1', { ...questionContent, statement: 'v2 text' });
    freezeQuestion(2);

    const { status, body } = await call(TEACHER, 'q1', {
      ...questionContent,
      statement: 'v3 text',
    });

    expect(status).toBe(201);
    expect(body.question.version).toBe(3);
  });

  it('counts a merely queued answer as in use', async () => {
    expect((await call(TEACHER, 'q1', questionContent)).status).toBe(201);
  });
});

describe('PUT /questions/{id}: access and input', () => {
  beforeEach(() => db.put('Questions', questionItem()));

  it.each(deniedRoles('TEACHER'))('refuses a %s with 403', async (role) => {
    expect((await call(userOf(role).email, 'q1', questionContent)).status).toBe(403);
    expect(stored()).toEqual(questionItem());
  });

  it("refuses another teacher's question with 403 and changes nothing", async () => {
    const { status } = await call(OTHER_TEACHER, 'q1', { ...questionContent, title: 'Hijacked' });

    expect(status).toBe(403);
    expect(stored()).toEqual(questionItem());
  });

  it('lets a super admin edit any question', async () => {
    expect(
      (await call('super-admin@college.edu', 'q1', { ...questionContent, title: 'By admin' }))
        .status,
    ).toBe(200);
    expect(stored()?.title).toBe('By admin');
  });

  it('answers 404 for an unknown question', async () => {
    expect((await call(TEACHER, 'nope', questionContent)).status).toBe(404);
  });

  it.each([
    ['no body', undefined],
    ['a missing field', { ...questionContent, statement: undefined }],
    [
      'too many examples',
      { ...questionContent, examples: Array(4).fill({ input: 'a', output: 'b' }) },
    ],
  ])('answers 422 for %s', async (_label, body) => {
    expect((await call(TEACHER, 'q1', body)).status).toBe(422);
    expect(stored()).toEqual(questionItem());
  });
});
