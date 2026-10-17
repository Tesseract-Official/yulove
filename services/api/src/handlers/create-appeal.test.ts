import type { AnswerItem, AppealItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  seedGradingWorld,
  TEACHER_A,
} from '../test-utils/answers.js';
import { handler } from './create-appeal.js';

const db = new FakeDb();
const S1 = 's1@college.edu';

const body = (extra: Record<string, unknown> = {}) => ({
  examId: EXAM_ID,
  questionNumber: 1,
  message: 'I think my answer was marked wrong',
  ...extra,
});
const call = (email: string, payload: unknown = body()) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/appeals', email, body: payload }));

const appeals = () => db.all<AppealItem>('Appeals');
const answer = (email = S1, n = 1) =>
  db.get<AnswerItem>('Answers', { examStudent: `${EXAM_ID}#${email}`, questionNumber: n });

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.put('Answers', answerItem(S1, 1));
  db.put('Answers', answerItem(S1, 2, { status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE' }));
  db.put('Answers', answerItem('s2@college.edu', 1));
});

describe('POST /appeals', () => {
  it('opens an appeal for the caller on a published exam', async () => {
    const { status, body: out } = await call(S1);

    expect(status).toBe(201);
    expect(out.appeal).toMatchObject({
      examId: EXAM_ID,
      studentEmail: S1,
      questionNumber: 1,
      message: 'I think my answer was marked wrong',
      status: 'OPEN',
    });
    expect(out.appeal.appealId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(out.appeal.createdAt)).not.toBeNaN();
    expect(appeals()).toHaveLength(1);
    expect(answer()?.openAppealId).toBe(out.appeal.appealId);
  });

  it('can appeal a question that could not be graded', async () => {
    expect((await call(S1, body({ questionNumber: 2 }))).status).toBe(201);
  });

  it('is always the caller: a student named in the body is ignored', async () => {
    const { body: out } = await call(S1, body({ studentEmail: 's2@college.edu' }));
    expect(out.appeal.studentEmail).toBe(S1);
    expect(answer('s2@college.edu')).not.toHaveProperty('openAppealId');
  });

  describe('one open appeal per question', () => {
    it('refuses a second while the first is open', async () => {
      await call(S1);
      const second = await call(S1, body({ message: 'Again' }));

      expect(second.status).toBe(409);
      expect(second.body.error.message).toMatch(/already have an open appeal/);
      expect(appeals()).toHaveLength(1);
    });

    it('lets a different question, and a different student, appeal', async () => {
      await call(S1);
      expect((await call(S1, body({ questionNumber: 2 }))).status).toBe(201);
      expect((await call('s2@college.edu')).status).toBe(201);
    });

    it('allows a new appeal once the first is closed or sent to be graded again', async () => {
      for (const status of ['CLOSED', 'RERUN'] as const) {
        const first = await call(S1);
        const { appealId } = first.body.appeal;
        // What PUT /appeals does: change the status and release the claim.
        db.put('Appeals', { ...appeals().find((a) => a.appealId === appealId)!, status });
        db.put('Answers', { ...answer()!, openAppealId: undefined });
        expect((await call(S1)).status).toBe(201);
        db.put('Answers', { ...answer()!, openAppealId: undefined });
      }
    });

    it('lets only one of two simultaneous appeals open', async () => {
      const results = await Promise.all([call(S1), call(S1, body({ message: 'Me too' }))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(appeals()).toHaveLength(1);
    });

    it('is not locked out by a mark whose appeal never got written', async () => {
      db.put('Answers', { ...answer()!, openAppealId: 'ghost' });
      expect((await call(S1)).status).toBe(201);
      expect(answer()?.openAppealId).not.toBe('ghost');
    });

    it('is not locked out by a mark left on a closed appeal', async () => {
      db.put('Appeals', {
        appealId: 'old',
        examId: EXAM_ID,
        studentEmail: S1,
        questionNumber: 1,
        message: 'x',
        status: 'CLOSED',
        createdAt: '2026-10-01T00:00:00Z',
      });
      db.put('Answers', { ...answer()!, openAppealId: 'old' });
      expect((await call(S1)).status).toBe(201);
    });
  });

  describe('an exam that is not published', () => {
    it.each(['READY', 'DRAFT'] as const)(
      'is a 404 for a %s exam, and nothing is written',
      async (st) => {
        db.put('Exams', examItem({ status: st }));
        expect((await call(S1)).status).toBe(404);
        expect(appeals()).toHaveLength(0);
        expect(answer()).not.toHaveProperty('openAppealId');
      },
    );

    it('is a 404 for an exam of another batch, and for one that does not exist', async () => {
      db.put('Exams', examItem({ status: 'PUBLISHED', batchId: 'B' }));
      expect((await call(S1)).status).toBe(404);
      expect((await call(S1, body({ examId: 'nope' }))).status).toBe(404);
    });
  });

  describe('is refused', () => {
    it('without a message, or with a blank one', async () => {
      expect((await call(S1, body({ message: '' }))).status).toBe(422);
      expect((await call(S1, body({ message: '   ' }))).status).toBe(422);
      expect((await call(S1, { examId: EXAM_ID, questionNumber: 1 })).status).toBe(422);
    });

    it('for a message over 1000 characters, but takes exactly 1000', async () => {
      expect((await call(S1, body({ message: 'x'.repeat(1001) }))).status).toBe(422);
      expect((await call(S1, body({ message: 'x'.repeat(1000) }))).status).toBe(201);
    });

    it('for a question the exam does not have', async () => {
      expect((await call(S1, body({ questionNumber: 9 }))).status).toBe(422);
    });

    it("for a question the student never answered (and never another student's)", async () => {
      // s2 answered question 1 only.
      expect((await call('s2@college.edu', body({ questionNumber: 2 }))).status).toBe(404);
      expect(answer(S1, 2)).not.toHaveProperty('openAppealId');
    });

    it('for a student marked absent', async () => {
      db.put('ExamStudents', examStudentRow(S1, { absent: true }));
      const { status, body: out } = await call(S1);
      expect(status).toBe(409);
      expect(out.error.message).toMatch(/absent/);
    });

    it.each([
      ['a batch manager', MANAGER],
      ['a teacher', TEACHER_A],
    ])('for %s with 403', async (_who, email) => {
      expect((await call(email)).status).toBe(403);
      expect(appeals()).toHaveLength(0);
    });

    it('for a student of another batch (404, not 403)', async () => {
      expect((await call('other-batch@college.edu')).status).toBe(404);
    });

    it('for someone with no body', async () => {
      const result = await invoke(
        handler,
        makeEvent({ method: 'POST', path: '/appeals', email: S1 }),
      );
      expect(result.status).toBe(422);
    });
  });
});
