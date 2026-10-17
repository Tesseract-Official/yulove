import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  MANAGER_B,
  seedGradingWorld,
  TEACHER_A,
  TEACHER_B,
} from '../test-utils/answers.js';
import { handler } from './get-exam-board.js';

const db = new FakeDb();
const call = (email: string, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({ method: 'GET', path: `/exams/${id}/answers`, email, pathParameters: { id } }),
  );

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
});

describe('GET /exams/{id}/answers', () => {
  it('lists every active student of the batch by roll number, with a cell per question', async () => {
    const { status, body } = await call(MANAGER);

    expect(status).toBe(200);
    expect(body.students.map((s: { rollNo: string }) => s.rollNo)).toEqual(['R1', 'R2', 'R3']);
    expect(body.questions).toEqual([
      { number: 1, marks: 10 },
      { number: 2, marks: 5 },
    ]);
    const first = body.students[0];
    expect(first).toMatchObject({
      email: 's1@college.edu',
      absent: false,
      totalScore: 0,
      maxScore: 15,
    });
    expect(first.questions).toEqual([
      { number: 1, marks: 10, status: 'NOT_SUBMITTED', score: 0, overridden: false },
      { number: 2, marks: 5, status: 'NOT_SUBMITTED', score: 0, overridden: false },
    ]);
    expect(body.counts).toEqual({ NOT_SUBMITTED: 6 });
  });

  it("shows each answer's status, failure reason and detail, and score", async () => {
    db.put('Answers', answerItem('s1@college.edu', 1));
    db.put(
      'Answers',
      answerItem('s1@college.edu', 2, {
        status: 'FAILED_TO_GRADE',
        failReason: 'DRIVER_MISMATCH',
        failDetail: 'The driver program changed the student code',
        testsPassed: undefined,
      }),
    );
    db.put('Answers', answerItem('s2@college.edu', 1, { status: 'RUNNING', score: undefined }));
    db.put('Answers', answerItem('s3@college.edu', 1, { status: 'QUEUED' }));

    const { body } = await call(MANAGER);
    const [s1, s2, s3] = body.students;

    expect(s1.questions[0]).toMatchObject({ status: 'GRADED', score: 5 });
    expect(s1.questions[1]).toMatchObject({
      status: 'FAILED_TO_GRADE',
      failReason: 'DRIVER_MISMATCH',
      failDetail: 'The driver program changed the student code',
      score: 0,
    });
    expect(s1.totalScore).toBe(5);
    expect(s2.questions[0].status).toBe('RUNNING');
    expect(s3.questions[0].status).toBe('QUEUED');
    expect(body.counts).toMatchObject({ GRADED: 1, FAILED_TO_GRADE: 1, RUNNING: 1, QUEUED: 1 });
  });

  it('marks an override on a question', async () => {
    db.put(
      'Answers',
      answerItem('s1@college.edu', 1, { override: { score: 9, reason: 'r', by: 'a', at: 't' } }),
    );
    const { body } = await call(MANAGER);
    expect(body.students[0].questions[0]).toMatchObject({ score: 9, overridden: true });
  });

  it('shows an absent student as absent with every score 0', async () => {
    db.put('Answers', answerItem('s1@college.edu', 1));
    db.put('ExamStudents', examStudentRow('s1@college.edu', { absent: true }));

    const { body } = await call(MANAGER);

    expect(body.students[0]).toMatchObject({ absent: true, totalScore: 0, maxScore: 15 });
    expect(body.students[0].questions[0]).toMatchObject({ status: 'GRADED', score: 0 });
  });

  it('leaves out inactive students, unless they have a row for the exam', async () => {
    expect(
      (await call(MANAGER)).body.students.map((s: { rollNo: string }) => s.rollNo),
    ).not.toContain('R9');

    db.put('ExamStudents', examStudentRow('inactive@college.edu'));
    expect((await call(MANAGER)).body.students.map((s: { rollNo: string }) => s.rollNo)).toContain(
      'R9',
    );
  });

  it('never includes students of another batch', async () => {
    const { body } = await call(MANAGER);
    expect(body.students.map((s: { email: string }) => s.email)).not.toContain(
      'other-batch@college.edu',
    );
  });

  describe('who may see it', () => {
    it.each([
      ['a batch manager of the batch', MANAGER],
      ['a teacher of the batch', TEACHER_A],
      ['a super admin', 'super-admin@college.edu'],
    ])('lets %s', async (_who, email) => {
      expect((await call(email)).status).toBe(200);
    });

    it.each([
      ['a student', 's1@college.edu'],
      ['a batch manager of another batch', MANAGER_B],
      ['a teacher of another batch', TEACHER_B],
    ])('refuses %s with 403', async (_who, email) => {
      expect((await call(email)).status).toBe(403);
    });

    it('answers 404 for an exam that does not exist', async () => {
      expect((await call(MANAGER, 'nope')).status).toBe(404);
    });

    it('works for any exam status, including a draft or a published exam', async () => {
      db.put('Exams', examItem({ status: 'PUBLISHED' }));
      expect((await call(MANAGER)).status).toBe(200);
      db.put('Exams', examItem({ status: 'DRAFT' }));
      expect((await call(MANAGER)).status).toBe(200);
    });

    it('refuses an inactive staff account', async () => {
      db.addUser(
        userOf('BATCH_MANAGER', { email: 'gone@college.edu', batchIds: ['A'], active: false }),
      );
      expect((await call('gone@college.edu')).status).toBe(403);
    });
  });
});
