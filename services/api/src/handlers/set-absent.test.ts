import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExamStudentItem } from '@yulove/shared';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  MANAGER_B,
  seedGradingWorld,
  TEACHER_A,
} from '../test-utils/answers.js';
import { handler as board } from './get-exam-board.js';
import { handler as results } from './get-exam-results.js';
import { handler } from './set-absent.js';

const db = new FakeDb();
const EMAIL = 's1@college.edu';

const call = (email: string, body: unknown, student = EMAIL, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({
      method: 'PUT',
      path: `/exams/${id}/students/${student}/absent`,
      email,
      pathParameters: { id, email: student },
      body,
    }),
  );
const row = () => db.get<ExamStudentItem>('ExamStudents', { examId: EXAM_ID, studentEmail: EMAIL });

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  db.put('Answers', answerItem(EMAIL, 1)); // 5
  db.put('Answers', answerItem(EMAIL, 2)); // 2.5
  db.put('ExamStudents', examStudentRow(EMAIL, { totalScore: 7.5, maxScore: 15 }));
});

describe('PUT /exams/{id}/students/{email}/absent', () => {
  it('marking absent sets the total to 0 and keeps the maximum', async () => {
    const { status, body } = await call(MANAGER, { absent: true });

    expect(status).toBe(200);
    expect(body).toMatchObject({ studentEmail: EMAIL, absent: true, totalScore: 0, maxScore: 15 });
    expect(row()).toMatchObject({ absent: true, totalScore: 0, maxScore: 15 });
  });

  it('gives 0 everywhere while absent, and unmarking restores the scores', async () => {
    const scores = async () => {
      const b = (
        await invoke(
          board,
          makeEvent({ method: 'GET', path: '/x', email: MANAGER, pathParameters: { id: EXAM_ID } }),
        )
      ).body;
      const r = (
        await invoke(
          results,
          makeEvent({
            method: 'GET',
            path: '/x',
            email: TEACHER_A,
            pathParameters: { id: EXAM_ID },
          }),
        )
      ).body;
      return {
        board: b.students[0].totalScore,
        boardCells: b.students[0].questions.map((q: { score: number }) => q.score),
        results: r.students[0].totalScore,
        resultCells: r.students[0].questions.map((q: { score: number }) => q.score),
      };
    };

    expect(await scores()).toEqual({
      board: 7.5,
      boardCells: [5, 2.5],
      results: 7.5,
      resultCells: [5, 2.5],
    });

    await call(MANAGER, { absent: true });
    expect(await scores()).toEqual({
      board: 0,
      boardCells: [0, 0],
      results: 0,
      resultCells: [0, 0],
    });
    expect(row()?.totalScore).toBe(0);

    const back = await call(MANAGER, { absent: false });
    expect(back.body).toMatchObject({ absent: false, totalScore: 7.5, maxScore: 15 });
    expect(await scores()).toEqual({
      board: 7.5,
      boardCells: [5, 2.5],
      results: 7.5,
      resultCells: [5, 2.5],
    });
    expect(row()).toMatchObject({ absent: false, totalScore: 7.5 });
  });

  it('honours an override when restoring', async () => {
    db.put(
      'Answers',
      answerItem(EMAIL, 1, { override: { score: 10, reason: 'r', by: 'a', at: 't' } }),
    );
    await call(MANAGER, { absent: true });
    expect((await call(MANAGER, { absent: false })).body.totalScore).toBe(12.5);
  });

  it('creates the row for a student imported after the exam', async () => {
    db.reset();
    seedGradingWorld(db);
    expect(row()).toBeUndefined();

    const { body } = await call(MANAGER, { absent: true }, 's2@college.edu');
    expect(body).toMatchObject({ absent: true, totalScore: 0 });
    expect(
      db.get<ExamStudentItem>('ExamStudents', { examId: EXAM_ID, studentEmail: 's2@college.edu' }),
    ).toMatchObject({ absent: true });
  });

  it('works whatever the answers are doing', async () => {
    db.put('Answers', answerItem(EMAIL, 1, { status: 'RUNNING' }));
    expect((await call(MANAGER, { absent: true })).status).toBe(200);
  });

  describe('is refused', () => {
    it.each([
      ['a teacher', TEACHER_A],
      ['a student', 's2@college.edu'],
      ['a batch manager of another batch', MANAGER_B],
    ])('for %s with 403, changing nothing', async (_who, email) => {
      expect((await call(email, { absent: true })).status).toBe(403);
      expect(row()?.absent).toBe(false);
    });

    it('lets a super admin through', async () => {
      expect((await call('super-admin@college.edu', { absent: true })).status).toBe(200);
    });

    it('for an unknown exam with 404', async () => {
      expect((await call(MANAGER, { absent: true }, EMAIL, 'nope')).status).toBe(404);
    });

    it.each([
      ['a student of another batch', 'other-batch@college.edu'],
      ['someone who is not a student', 'teacher@college.edu'],
      ['an unknown address', 'nobody@college.edu'],
    ])('for %s with 404', async (_who, student) => {
      expect((await call(MANAGER, { absent: true }, student)).status).toBe(404);
    });

    it.each([[{}], [{ absent: 'yes' }], [undefined]])('for the body %j with 422', async (body) => {
      expect((await call(MANAGER, body)).status).toBe(422);
      expect(row()?.absent).toBe(false);
    });
  });
});
