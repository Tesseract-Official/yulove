import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '@yulove/shared/testing';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './list-students.js';

const db = new FakeDb();
const call = (email: string, batchId: string, search?: string) =>
  invoke(
    handler,
    makeEvent({
      method: 'GET',
      path: `/batches/${batchId}/students`,
      email,
      pathParameters: { batchId },
      query: search === undefined ? undefined : { search },
    }),
  );

const student = (n: number, name: string, batchId = 'A') =>
  userOf('STUDENT', { email: `s${n}@college.edu`, name, rollNo: `CS${n}`, batchId });

beforeEach(() => {
  db.reset();
  db.addBatch('A');
  db.addBatch('B');
  db.addBatch('C');
  db.addUser(student(10, 'Asha Rao'));
  db.addUser(student(2, 'Bilal Khan'));
  db.addUser(student(3, 'Chitra Rao'));
  db.addUser(student(4, 'Other Batch', 'B'));
  db.addUser(userOf('SUPER_ADMIN'));
  db.addUser(userOf('BATCH_MANAGER', { batchIds: ['A', 'C'] }));
  db.addUser(userOf('TEACHER', { batchIds: ['A'] }));
  db.addUser(userOf('STUDENT', { email: 'caller@college.edu', batchId: 'A', rollNo: 'CS99' }));
});

const rolls = (body: { students: { rollNo: string }[] }) => body.students.map((s) => s.rollNo);

describe('GET /batches/{batchId}/students', () => {
  it.each(['batch-manager@college.edu', 'teacher@college.edu', 'super-admin@college.edu'])(
    'lists the batch for %s, sorted by roll number',
    async (email) => {
      const { status, body } = await call(email, 'A');

      expect(status).toBe(200);
      // Natural sort: CS2, CS3, CS10 (and the caller student CS99).
      expect(rolls(body)).toEqual(['CS2', 'CS3', 'CS10', 'CS99']);
      expect(body.students[0]).toEqual({
        email: 's2@college.edu',
        name: 'Bilal Khan',
        rollNo: 'CS2',
        batchId: 'A',
        active: true,
      });
    },
  );

  it.each([
    ['roll number', 'cs10', ['CS10']],
    ['part of a roll number', 'cs1', ['CS10']],
    ['name, case-insensitive', 'RAO', ['CS3', 'CS10']],
    ['email', 's2@', ['CS2']],
    ['nothing matching', 'zzz', []],
    ['blank search (everything)', '   ', ['CS2', 'CS3', 'CS10', 'CS99']],
  ])('searches by %s', async (_label, search, expected) => {
    const { status, body } = await call('batch-manager@college.edu', 'A', search);

    expect(status).toBe(200);
    expect(rolls(body)).toEqual(expected);
  });

  it('never returns students of other batches', async () => {
    const { body } = await call('super-admin@college.edu', 'A', 'Other');
    expect(body.students).toEqual([]);
  });

  it('never returns non-students found through the batch index', async () => {
    db.addUser(userOf('TEACHER', { email: 'odd@college.edu', batchId: 'A', name: 'Odd' }));
    const { body } = await call('batch-manager@college.edu', 'A', 'odd');
    expect(body.students).toEqual([]);
  });

  it.each(deniedRoles('BATCH_MANAGER', 'TEACHER'))('refuses a %s with 403', async (role) => {
    expect((await call(userOf(role, { batchId: 'A' }).email, 'A')).status).toBe(403);
  });

  it.each([
    ['a batch manager', 'batch-manager@college.edu'],
    ['a teacher', 'teacher@college.edu'],
  ])('refuses %s for a batch they are not assigned to with 403', async (_label, email) => {
    const { status, body } = await call(email, 'B');

    expect(status).toBe(403);
    expect(JSON.stringify(body)).not.toContain('Other Batch');
  });

  it('refuses a teacher for a batch that only the manager has', async () => {
    expect((await call('teacher@college.edu', 'C')).status).toBe(403);
  });

  it('answers 404 for a batch that does not exist (super admin)', async () => {
    expect((await call('super-admin@college.edu', 'NOPE')).status).toBe(404);
  });

  it('answers 422 for a search that is too long', async () => {
    expect((await call('batch-manager@college.edu', 'A', 'x'.repeat(101))).status).toBe(422);
  });
});
