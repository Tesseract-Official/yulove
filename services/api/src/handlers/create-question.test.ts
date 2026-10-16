import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { questionContent, seedPeople, TEACHER } from '../test-utils/questions.js';
import { handler } from './create-question.js';

const db = new FakeDb();
const call = (email: string, body: unknown) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/questions', email, body }));

beforeEach(() => {
  db.reset();
  db.addBatch('A');
  seedPeople(db);
});

describe('POST /questions', () => {
  it('creates version 1 owned by the teacher, with no test status', async () => {
    const { status, body } = await call(TEACHER, questionContent);

    expect(status).toBe(201);
    expect(body.question).toMatchObject({ ...questionContent, version: 1, teacherEmail: TEACHER });
    expect(body.question.questionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.question.testStatus).toBeUndefined();

    const [stored] = db.all('Questions');
    expect(stored).toEqual(body.question);
  });

  it('gives every question its own id', async () => {
    const a = await call(TEACHER, questionContent);
    const b = await call(TEACHER, questionContent);
    expect(a.body.question.questionId).not.toBe(b.body.question.questionId);
  });

  it('lets a super admin create a question, owned by them', async () => {
    const { status, body } = await call('super-admin@college.edu', questionContent);
    expect(status).toBe(201);
    expect(body.question.teacherEmail).toBe('super-admin@college.edu');
  });

  it.each(deniedRoles('TEACHER'))('refuses a %s with 403 and creates nothing', async (role) => {
    expect((await call(userOf(role).email, questionContent)).status).toBe(403);
    expect(db.all('Questions')).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['a non-JSON body', 'not json'],
    ['no examples', { ...questionContent, examples: [] }],
    ['four examples', { ...questionContent, examples: Array(4).fill({ input: 'a', output: 'b' }) }],
    ['an unknown compare mode', { ...questionContent, compareMode: 'LOOSE' }],
    ['a zero time limit', { ...questionContent, timeLimitMs: 0 }],
    ['a missing title', { ...questionContent, title: ' ' }],
  ])('answers 422 for %s', async (_label, body) => {
    expect((await call(TEACHER, body)).status).toBe(422);
    expect(db.all('Questions')).toEqual([]);
  });
});
