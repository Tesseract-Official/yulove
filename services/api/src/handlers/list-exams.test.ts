import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { examItem } from '../test-utils/exams.js';
import { MANAGER, MANAGER_B, TEACHER_A, seedGradingWorld } from '../test-utils/answers.js';
import { handler } from './list-exams.js';

const db = new FakeDb();
const call = (email: string | undefined, query?: Record<string, string>) =>
  invoke(handler, makeEvent({ method: 'GET', path: '/exams', email, query }));

beforeEach(() => {
  db.reset();
  seedGradingWorld(db); // exam-1: READY, batch A, 2 questions, 2026-10-24
  db.put(
    'Exams',
    examItem({
      examId: 'exam-0',
      title: 'Week 2 test',
      date: '2026-10-17',
      status: 'PUBLISHED',
      questions: [{ number: 1, questionId: 'q1', version: 1, marks: 10 }],
    }),
  );
  db.put(
    'Exams',
    examItem({ examId: 'exam-b', batchId: 'B', title: 'B test', date: '2026-10-20' }),
  );
});

describe('GET /exams', () => {
  it('lists the exams of a batch with id, title, date, status and question count, newest first', async () => {
    const { status, body } = await call(MANAGER, { batchId: 'A' });

    expect(status).toBe(200);
    expect(body.exams).toEqual([
      {
        examId: 'exam-1',
        batchId: 'A',
        title: 'Week 3 test',
        date: '2026-10-24',
        status: 'READY',
        questionCount: 2,
        createdBy: TEACHER_A,
      },
      {
        examId: 'exam-0',
        batchId: 'A',
        title: 'Week 2 test',
        date: '2026-10-17',
        status: 'PUBLISHED',
        questionCount: 1,
        createdBy: TEACHER_A,
      },
    ]);
  });

  it('shows a teacher the batch exams made by any teacher', async () => {
    db.put('Exams', examItem({ examId: 'exam-x', createdBy: 'other-teacher@college.edu' }));

    const { body } = await call(TEACHER_A, { batchId: 'A' });

    expect(body.exams.map((e: { examId: string }) => e.examId)).toContain('exam-x');
  });

  it('refuses a batch the caller is not assigned to', async () => {
    expect((await call(MANAGER, { batchId: 'B' })).status).toBe(403);
    expect((await call(TEACHER_A, { batchId: 'B' })).status).toBe(403);
    expect((await call(MANAGER_B, { batchId: 'A' })).status).toBe(403);
  });

  it('refuses a batch that does not exist, for staff, and lists nothing for a super admin', async () => {
    expect((await call(MANAGER, { batchId: 'NOPE' })).status).toBe(403);
    const superAdmin = await call(userOf('SUPER_ADMIN').email, { batchId: 'NOPE' });
    expect(superAdmin.body).toEqual({ exams: [] });
  });

  it('lets a super admin list any batch, and with no batch, every exam', async () => {
    const admin = userOf('SUPER_ADMIN').email;

    const one = await call(admin, { batchId: 'B' });
    const all = await call(admin);

    expect(one.body.exams.map((e: { examId: string }) => e.examId)).toEqual(['exam-b']);
    expect(all.body.exams.map((e: { examId: string }) => e.examId)).toEqual([
      'exam-1',
      'exam-b',
      'exam-0',
    ]);
  });

  it('without a batch, lists only the exams of the batches the caller is assigned to', async () => {
    const mine = await call(MANAGER);
    const other = await call(MANAGER_B);

    expect(mine.body.exams.map((e: { examId: string }) => e.examId)).toEqual(['exam-1', 'exam-0']);
    expect(other.body.exams.map((e: { examId: string }) => e.examId)).toEqual(['exam-b']);
  });

  it('returns an empty list for staff with no batches', async () => {
    db.addUser(userOf('BATCH_MANAGER', { email: 'new@college.edu' }));

    expect((await call('new@college.edu')).body).toEqual({ exams: [] });
  });

  it('rejects an empty batchId', async () => {
    const { status, body } = await call(MANAGER, { batchId: '  ' });

    expect(status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it.each(deniedRoles('TEACHER', 'BATCH_MANAGER'))('refuses a %s', async (role) => {
    db.addUser(userOf(role, { email: 'denied@college.edu', batchId: 'A', batchIds: ['A'] }));

    expect((await call('denied@college.edu', { batchId: 'A' })).status).toBe(403);
    expect((await call('denied@college.edu')).status).toBe(403);
  });

  it('answers 401 without an email claim', async () => {
    expect((await call(undefined, { batchId: 'A' })).status).toBe(401);
  });
});
