import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { examItem } from '../test-utils/exams.js';
import {
  OTHER_TEACHER,
  TEACHER,
  questionItem,
  seedPeople,
  signature,
} from '../test-utils/questions.js';
import { handler } from './list-questions.js';

const db = new FakeDb();
const call = (email: string | undefined) =>
  invoke(handler, makeEvent({ method: 'GET', path: '/questions', email }));
const ids = (body: { questions: Array<{ questionId: string }> }) =>
  body.questions.map((q) => q.questionId);

beforeEach(() => {
  db.reset();
  seedPeople(db);
  db.put(
    'Questions',
    questionItem({ questionId: 'q-b', title: 'Bravo', testStatus: 'APPROVED', signature }),
  );
  db.put(
    'Questions',
    questionItem({ questionId: 'q-a', title: 'Alpha', testStatus: 'NEEDS_REVIEW' }),
  );
  db.put(
    'Questions',
    questionItem({
      questionId: 'q-f',
      title: 'Failed one',
      testStatus: 'GENERATION_FAILED',
      testFailure: 'Gemini was busy',
    }),
  );
  db.put(
    'Questions',
    questionItem({ questionId: 'q-other', title: 'Not mine', teacherEmail: OTHER_TEACHER }),
  );
});

describe('GET /questions', () => {
  it('lists a teacher’s own questions, by title, with the state of their tests', async () => {
    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(ids(body)).toEqual(['q-a', 'q-b', 'q-f']);
    expect(body.questions[0]).toMatchObject({
      questionId: 'q-a',
      version: 1,
      title: 'Alpha',
      targetComplexity: 'O(n)',
      teacherEmail: TEACHER,
      testStatus: 'NEEDS_REVIEW',
      usedInExams: 0,
    });
    expect(body.questions[2]).toMatchObject({
      testStatus: 'GENERATION_FAILED',
      testFailure: 'Gemini was busy',
    });
  });

  it('never shows another teacher’s questions', async () => {
    expect(ids((await call(TEACHER)).body)).not.toContain('q-other');
    expect(ids((await call(OTHER_TEACHER)).body)).toEqual(['q-other']);
  });

  it('lets a super admin see every teacher’s questions', async () => {
    const { body } = await call(userOf('SUPER_ADMIN').email);

    expect(ids(body).sort()).toEqual(['q-a', 'q-b', 'q-f', 'q-other']);
  });

  it('shows only the latest version of a question', async () => {
    db.put('Questions', questionItem({ questionId: 'q-b', version: 2, title: 'Bravo v2' }));

    const { body } = await call(TEACHER);

    const bravo = body.questions.filter((q: { questionId: string }) => q.questionId === 'q-b');
    expect(bravo).toHaveLength(1);
    expect(bravo[0]).toMatchObject({ version: 2, title: 'Bravo v2' });
    expect(bravo[0].testStatus).toBeUndefined();
  });

  it('counts the exams that use the latest version', async () => {
    db.put('Questions', questionItem({ questionId: 'q-b', version: 2, title: 'Bravo v2' }));
    const uses = (examId: string, version: number) =>
      examItem({
        examId,
        questions: [{ number: 1, questionId: 'q-b', version, marks: 5 }],
      });
    db.put('Exams', uses('e1', 2));
    db.put('Exams', uses('e2', 2));
    db.put('Exams', uses('e3', 1)); // an old version: not counted

    const { body } = await call(TEACHER);

    expect(
      body.questions.find((q: { questionId: string }) => q.questionId === 'q-b').usedInExams,
    ).toBe(2);
    expect(
      body.questions.find((q: { questionId: string }) => q.questionId === 'q-a').usedInExams,
    ).toBe(0);
  });

  it('returns an empty list for a teacher with no questions', async () => {
    db.addUser(userOf('TEACHER', { email: 'new@college.edu', batchIds: ['A'] }));

    expect((await call('new@college.edu')).body).toEqual({ questions: [] });
  });

  it.each(deniedRoles('TEACHER'))('refuses a %s', async (role) => {
    db.addUser(userOf(role, { email: 'denied@college.edu', batchId: 'A', batchIds: ['A'] }));

    expect((await call('denied@college.edu')).status).toBe(403);
  });

  it('answers 401 without an email claim, and 403 for an unknown account', async () => {
    expect((await call(undefined)).status).toBe(401);
    expect((await call('nobody@college.edu')).status).toBe(403);
  });
});
