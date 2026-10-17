import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { examItem } from '../test-utils/exams.js';
import { answerItem } from '../test-utils/answers.js';
import {
  OTHER_TEACHER,
  TEACHER,
  questionItem,
  seedPeople,
  signature,
} from '../test-utils/questions.js';
import { handler } from './get-question.js';

const db = new FakeDb();
const call = (email: string | undefined, id = 'q1') =>
  invoke(
    handler,
    makeEvent({ method: 'GET', path: `/questions/${id}`, email, pathParameters: { id } }),
  );

beforeEach(() => {
  db.reset();
  seedPeople(db);
  db.put(
    'Questions',
    questionItem({
      testStatus: 'NEEDS_REVIEW',
      signature,
      testCount: 10,
      testsKey: 'questions/q1/v1/tests.json',
      testAttempt: 3,
    }),
  );
});

describe('GET /questions/{id}', () => {
  it('returns the question the teacher wrote, with its tests state', async () => {
    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(body.question).toMatchObject({
      questionId: 'q1',
      version: 1,
      teacherEmail: TEACHER,
      title: 'Two Sum',
      statement: 'Find two numbers that add up to the target.',
      targetComplexity: 'O(n)',
      timeLimitMs: 2000,
      memoryMb: 256,
      compareMode: 'EXACT',
      testStatus: 'NEEDS_REVIEW',
      testCount: 10,
      signature,
    });
    expect(body.inUse).toBe(false);
    expect(body.usedInExams).toBe(0);
  });

  it('keeps the internal bookkeeping out of the response', async () => {
    const { body } = await call(TEACHER);

    expect(Object.keys(body.question)).not.toEqual(expect.arrayContaining(['testAttempt']));
    expect(JSON.stringify(body)).not.toContain('tests.json');
    expect(JSON.stringify(body)).not.toContain('testAttempt');
  });

  it('shows the failure reason', async () => {
    db.put(
      'Questions',
      questionItem({ testStatus: 'GENERATION_FAILED', testFailure: 'Gemini was busy' }),
    );

    expect((await call(TEACHER)).body.question).toMatchObject({
      testStatus: 'GENERATION_FAILED',
      testFailure: 'Gemini was busy',
    });
  });

  it('returns the latest version', async () => {
    db.put('Questions', questionItem({ version: 2, title: 'Two Sum v2' }));

    expect((await call(TEACHER)).body.question).toMatchObject({ version: 2, title: 'Two Sum v2' });
  });

  it('counts the exams that use it, and is not in use until an answer exists', async () => {
    db.put('Exams', examItem({ examId: 'e1' }));
    db.put('Exams', examItem({ examId: 'e2' }));

    const { body } = await call(TEACHER);

    expect(body.usedInExams).toBe(2);
    expect(body.inUse).toBe(false);
  });

  it('is in use once an exam that uses it has an answer', async () => {
    db.addUser(userOf('STUDENT', { email: 's1@college.edu', batchId: 'A', rollNo: 'R1' }));
    db.put('Exams', examItem());
    db.put('Answers', answerItem('s1@college.edu', 1));

    const { body } = await call(TEACHER);

    expect(body.inUse).toBe(true);
    expect(body.usedInExams).toBe(1);
  });

  it('is not in use because of an exam that uses another version', async () => {
    db.addUser(userOf('STUDENT', { email: 's1@college.edu', batchId: 'A', rollNo: 'R1' }));
    db.put('Questions', questionItem({ version: 2 }));
    db.put('Exams', examItem()); // uses version 1
    db.put('Answers', answerItem('s1@college.edu', 1));

    const { body } = await call(TEACHER);

    expect(body.question.version).toBe(2);
    expect(body.inUse).toBe(false);
    expect(body.usedInExams).toBe(0);
  });

  it('refuses another teacher’s question, but lets a super admin read any', async () => {
    expect((await call(OTHER_TEACHER)).status).toBe(403);
    expect((await call(userOf('SUPER_ADMIN').email)).status).toBe(200);
  });

  it('answers 404 for a question that does not exist', async () => {
    expect((await call(TEACHER, 'nope')).status).toBe(404);
  });

  it.each(deniedRoles('TEACHER'))('refuses a %s', async (role) => {
    db.addUser(userOf(role, { email: 'denied@college.edu', batchId: 'A', batchIds: ['A'] }));

    expect((await call('denied@college.edu')).status).toBe(403);
  });

  it('answers 401 without an email claim', async () => {
    expect((await call(undefined)).status).toBe(401);
  });
});
