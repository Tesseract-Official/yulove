import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import { TEACHER_A, TEACHER_B, answerItem, seedGradingWorld } from '../test-utils/answers.js';
import { OTHER_TEACHER, questionItem } from '../test-utils/questions.js';
import { handler } from './get-exam.js';

const db = new FakeDb();
const call = (email: string | undefined, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({ method: 'GET', path: `/exams/${id}`, email, pathParameters: { id } }),
  );

beforeEach(() => {
  db.reset();
  seedGradingWorld(db); // READY exam-1, batch A, made by teacher@college.edu; questions q1 and q2 approved
});

describe('GET /exams/{id}', () => {
  it('returns the exam with each question’s title and test state', async () => {
    const { status, body } = await call(TEACHER_A);

    expect(status).toBe(200);
    expect(body.exam).toMatchObject({
      examId: EXAM_ID,
      batchId: 'A',
      title: 'Week 3 test',
      date: '2026-10-24',
      status: 'READY',
      createdBy: TEACHER_A,
    });
    expect(body.exam.questions).toEqual([
      {
        number: 1,
        questionId: 'q1',
        version: 1,
        marks: 10,
        title: 'Two Sum',
        testStatus: 'APPROVED',
        exists: true,
      },
      {
        number: 2,
        questionId: 'q2',
        version: 1,
        marks: 5,
        title: 'Valid Parentheses',
        testStatus: 'APPROVED',
        exists: true,
      },
    ]);
  });

  it('says whether answers exist (the questions and marks are then locked)', async () => {
    expect((await call(TEACHER_A)).body.hasAnswers).toBe(false);

    db.put('Answers', answerItem('s1@college.edu', 1));

    expect((await call(TEACHER_A)).body.hasAnswers).toBe(true);
  });

  it('says whether a PDF has been made', async () => {
    expect((await call(TEACHER_A)).body.hasPdf).toBe(false);

    db.put('Exams', examItem({ status: 'READY', pdfKey: 'exams/exam-1/paper.pdf' }));

    const { body } = await call(TEACHER_A);
    expect(body.hasPdf).toBe(true);
    expect(JSON.stringify(body)).not.toContain('paper.pdf');
  });

  it('lets the exam’s creator edit it, and no one else except a super admin', async () => {
    expect((await call(TEACHER_A)).body.canEdit).toBe(true);
    db.addUser(userOf('TEACHER', { email: OTHER_TEACHER, batchIds: ['A'] }));
    // Another teacher of the batch can read the exam but not change it.
    const other = await call(OTHER_TEACHER);
    expect(other.status).toBe(200);
    expect(other.body.canEdit).toBe(false);
    expect((await call(userOf('SUPER_ADMIN').email)).body.canEdit).toBe(true);
  });

  it('cannot be edited once published, by anyone', async () => {
    db.put('Exams', examItem({ status: 'PUBLISHED', publishedAt: '2026-10-25T10:00:00.000Z' }));

    expect((await call(TEACHER_A)).body.canEdit).toBe(false);
    expect((await call(userOf('SUPER_ADMIN').email)).body.canEdit).toBe(false);
    expect((await call(TEACHER_A)).body.exam.publishedAt).toBe('2026-10-25T10:00:00.000Z');
  });

  it('shows a question version that no longer exists as missing', async () => {
    db.put(
      'Exams',
      examItem({ questions: [{ number: 1, questionId: 'gone', version: 4, marks: 10 }] }),
    );

    const { body } = await call(TEACHER_A);

    expect(body.exam.questions[0]).toMatchObject({ questionId: 'gone', exists: false });
    expect(body.exam.questions[0].title).toBeUndefined();
  });

  it('flags a question whose tests are no longer approved', async () => {
    db.put(
      'Questions',
      questionItem({ questionId: 'q1', title: 'Two Sum', testStatus: 'GENERATING' }),
    );

    expect((await call(TEACHER_A)).body.exam.questions[0].testStatus).toBe('GENERATING');
  });

  it('refuses a teacher of another batch, and answers 404 for an unknown exam', async () => {
    expect((await call(TEACHER_B)).status).toBe(403);
    expect((await call(TEACHER_A, 'nope')).status).toBe(404);
  });

  it.each(deniedRoles('TEACHER'))('refuses a %s', async (role) => {
    db.addUser(userOf(role, { email: 'denied@college.edu', batchId: 'A', batchIds: ['A'] }));

    expect((await call('denied@college.edu')).status).toBe(403);
  });

  it('answers 401 without an email claim', async () => {
    expect((await call(undefined)).status).toBe(401);
  });
});
