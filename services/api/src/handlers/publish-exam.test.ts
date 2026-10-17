import type { ExamItem, ExamStudentItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  MANAGER_B,
  seedGradingWorld,
  TEACHER_A,
} from '../test-utils/answers.js';
import { handler } from './publish-exam.js';

const db = new FakeDb();

const call = (email: string, body?: unknown, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({
      method: 'POST',
      path: `/exams/${id}/publish`,
      email,
      pathParameters: { id },
      body,
    }),
  );
const exam = () => db.get<ExamItem>('Exams', { examId: EXAM_ID });
const total = (email: string) =>
  db.get<ExamStudentItem>('ExamStudents', { examId: EXAM_ID, studentEmail: email });

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  db.put('Answers', answerItem('s1@college.edu', 1)); // 5
  db.put('Answers', answerItem('s1@college.edu', 2)); // 2.5
  db.put('Answers', answerItem('s2@college.edu', 1, { testsPassed: 10 })); // 10
  vi.useRealTimers();
});

describe('POST /exams/{id}/publish', () => {
  it('publishes an exam with nothing in flight, recording who and when', async () => {
    const before = Date.now();
    const { status, body } = await call(MANAGER);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'PUBLISHED', publishedBy: MANAGER, inProgress: 0 });
    expect(exam()).toMatchObject({ status: 'PUBLISHED', publishedBy: MANAGER });
    expect(Date.parse(exam()?.publishedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
  });

  it("works out every student's total first", async () => {
    await call(MANAGER);

    expect(total('s1@college.edu')).toMatchObject({ totalScore: 7.5, maxScore: 15 });
    expect(total('s2@college.edu')).toMatchObject({ totalScore: 10, maxScore: 15 });
    expect(total('s3@college.edu')).toMatchObject({ totalScore: 0, maxScore: 15 });
  });

  describe('with answers still being graded', () => {
    beforeEach(() => {
      db.put('Answers', answerItem('s2@college.edu', 2, { status: 'QUEUED' }));
      db.put('Answers', answerItem('s3@college.edu', 1, { status: 'TRANSCRIBING' }));
      db.put('Answers', answerItem('s3@college.edu', 2, { status: 'RUNNING' }));
    });

    it('answers 409 with the count and does not publish', async () => {
      const { status, body } = await call(MANAGER);

      expect(status).toBe(409);
      expect(body.error.details).toEqual({ inProgress: 3 });
      expect(body.error.message).toMatch(/3 answers are still being graded/);
      expect(exam()?.status).toBe('READY');
      expect(exam()).not.toHaveProperty('publishedBy');
    });

    it.each([[undefined], [{}], [{ confirm: false }]])(
      'is still refused when the body is %j',
      async (body) => {
        expect((await call(MANAGER, body)).status).toBe(409);
        expect(exam()?.status).toBe('READY');
      },
    );

    it('publishes with confirm: true', async () => {
      const { status, body } = await call(MANAGER, { confirm: true });

      expect(status).toBe(200);
      expect(body).toMatchObject({ status: 'PUBLISHED', inProgress: 3 });
      expect(exam()).toMatchObject({ status: 'PUBLISHED', publishedBy: MANAGER });
    });

    it('says "1 answer is" for one', async () => {
      db.put('Answers', answerItem('s2@college.edu', 2));
      db.put('Answers', answerItem('s3@college.edu', 1));
      db.put('Answers', answerItem('s3@college.edu', 2));
      db.put('Answers', answerItem('s3@college.edu', 2, { status: 'QUEUED' }));
      const { body } = await call(MANAGER);
      expect(body.error.message).toMatch(/^1 answer is still being graded/);
    });

    it('does not count answers of absent students', async () => {
      db.put('ExamStudents', examStudentRow('s3@college.edu', { absent: true }));
      const { body } = await call(MANAGER);
      expect(body.error.details).toEqual({ inProgress: 1 });
    });

    it('does not count failed or graded answers', async () => {
      db.put(
        'Answers',
        answerItem('s2@college.edu', 2, { status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE' }),
      );
      db.put('Answers', answerItem('s3@college.edu', 1));
      db.put('Answers', answerItem('s3@college.edu', 2));
      const { status } = await call(MANAGER);
      expect(status).toBe(200);
    });
  });

  it('refuses an exam that is not READY', async () => {
    db.put('Exams', examItem({ status: 'DRAFT' }));
    const { status, body } = await call(MANAGER, { confirm: true });
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/READY/);
    expect(exam()?.status).toBe('DRAFT');
  });

  it('does nothing the second time', async () => {
    await call(MANAGER);
    const first = exam();

    const { status, body } = await call(MANAGER, { confirm: true });

    expect(status).toBe(200);
    expect(body).toMatchObject({ alreadyPublished: true, publishedBy: MANAGER });
    expect(exam()).toEqual(first);
  });

  it('rejects a body that is not valid', async () => {
    expect((await call(MANAGER, { confirm: 'yes' })).status).toBe(422);
    expect(exam()?.status).toBe('READY');
  });

  describe('who may publish', () => {
    it.each([
      ['a teacher', TEACHER_A],
      ['a student', 's1@college.edu'],
      ['a batch manager of another batch', MANAGER_B],
    ])('refuses %s with 403', async (_who, email) => {
      expect((await call(email)).status).toBe(403);
      expect(exam()?.status).toBe('READY');
    });

    it('lets a super admin publish', async () => {
      expect((await call('super-admin@college.edu')).status).toBe(200);
    });

    it('answers 404 for an unknown exam', async () => {
      expect((await call(MANAGER, undefined, 'nope')).status).toBe(404);
    });
  });
});
