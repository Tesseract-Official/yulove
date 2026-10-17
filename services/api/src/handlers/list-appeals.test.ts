import type { AppealItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID } from '../test-utils/exams.js';
import {
  MANAGER,
  MANAGER_B,
  seedGradingWorld,
  TEACHER_A,
  TEACHER_B,
} from '../test-utils/answers.js';
import { handler } from './list-appeals.js';

const db = new FakeDb();

const appeal = (id: string, extra: Partial<AppealItem> = {}): AppealItem => ({
  appealId: id,
  examId: EXAM_ID,
  studentEmail: 's1@college.edu',
  questionNumber: 1,
  message: `message ${id}`,
  status: 'OPEN',
  createdAt: `2026-10-2${id}T10:00:00.000Z`,
  ...extra,
});
const call = (email: string, query: Record<string, string> = { examId: EXAM_ID }) =>
  invoke(handler, makeEvent({ method: 'GET', path: '/appeals', email, query }));

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  db.put('Appeals', appeal('1'));
  db.put('Appeals', appeal('2', { studentEmail: 's2@college.edu', status: 'RERUN' }));
  db.put('Appeals', appeal('3', { status: 'CLOSED', note: 'Checked' }));
  db.put('Appeals', appeal('4', { examId: 'other-exam' }));
});

describe('GET /appeals', () => {
  it("lists the exam's appeals newest first with the student's name and roll number", async () => {
    const { status, body } = await call(MANAGER);

    expect(status).toBe(200);
    expect(body.appeals.map((a: AppealItem) => a.appealId)).toEqual(['3', '2', '1']);
    expect(body.appeals[1]).toMatchObject({
      studentEmail: 's2@college.edu',
      studentName: 'STUDENT user',
      rollNo: 'R2',
      status: 'RERUN',
    });
  });

  it('can be limited to one status', async () => {
    for (const [wanted, ids] of [
      ['OPEN', ['1']],
      ['RERUN', ['2']],
      ['CLOSED', ['3']],
    ] as const) {
      const { body } = await call(TEACHER_A, { examId: EXAM_ID, status: wanted });
      expect(body.appeals.map((a: AppealItem) => a.appealId)).toEqual(ids);
    }
  });

  it('is open to a batch manager, a teacher and a super admin of the batch', async () => {
    for (const email of [MANAGER, TEACHER_A, 'super-admin@college.edu']) {
      expect((await call(email)).status).toBe(200);
    }
  });

  it.each([
    ['a student', 's1@college.edu'],
    ['a batch manager of another batch', MANAGER_B],
    ['a teacher of another batch', TEACHER_B],
  ])('refuses %s with 403', async (_who, email) => {
    expect((await call(email)).status).toBe(403);
  });

  it('needs an exam (422), a valid status (422) and an exam that exists (404)', async () => {
    expect((await call(MANAGER, {})).status).toBe(422);
    expect((await call(MANAGER, { examId: EXAM_ID, status: 'DONE' })).status).toBe(422);
    expect((await call(MANAGER, { examId: 'nope' })).status).toBe(404);
  });
});
