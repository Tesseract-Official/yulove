import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '@yulove/shared/testing';
import { invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './get-me.js';

const db = new FakeDb();
const call = (email?: string) => invoke(handler, makeEvent({ method: 'GET', path: '/me', email }));

beforeEach(() => {
  db.reset();
  db.addBatch('A', 'Alpha');
  db.addBatch('B', 'Beta');
});

describe('GET /me', () => {
  it('returns a student with their batch', async () => {
    db.addUser(userOf('STUDENT', { batchId: 'A', rollNo: 'R1' }));

    const { status, body } = await call('student@college.edu');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      email: 'student@college.edu',
      role: 'STUDENT',
      rollNo: 'R1',
      batches: [{ batchId: 'A', name: 'Alpha' }],
    });
  });

  it.each(['TEACHER', 'BATCH_MANAGER'] as const)(
    'returns a %s with assigned batches',
    async (role) => {
      db.addUser(userOf(role, { batchIds: ['B', 'A', 'GONE'] }));

      const { status, body } = await call(userOf(role).email);

      expect(status).toBe(200);
      // Deleted batches are skipped.
      expect(body.batches).toEqual([
        { batchId: 'B', name: 'Beta' },
        { batchId: 'A', name: 'Alpha' },
      ]);
    },
  );

  it('returns every batch to a super admin', async () => {
    db.addUser(userOf('SUPER_ADMIN'));

    const { body } = await call('super-admin@college.edu');

    expect(body.role).toBe('SUPER_ADMIN');
    expect(body.batches.map((b: { batchId: string }) => b.batchId)).toEqual(['A', 'B']);
  });

  it('finds a user stored in lower case when the JWT email has capitals', async () => {
    db.addUser(userOf('STUDENT', { email: 'student@college.edu', batchId: 'A' }));

    const { status, body } = await call('Student@College.edu');

    expect(status).toBe(200);
    expect(body.email).toBe('student@college.edu');
  });

  it('answers 401 without an email claim', async () => {
    expect((await call(undefined)).status).toBe(401);
  });

  it('answers 403 for a user who is not registered', async () => {
    expect((await call('stranger@college.edu')).status).toBe(403);
  });

  it('answers 403 for a deactivated user', async () => {
    db.addUser(userOf('STUDENT', { batchId: 'A', active: false }));
    expect((await call('student@college.edu')).status).toBe(403);
  });
});
