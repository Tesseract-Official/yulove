import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { MANAGER, MANAGER_B, TEACHER_A, seedGradingWorld } from '../test-utils/answers.js';
import { handler } from './list-batches.js';

const db = new FakeDb();
const call = (email: string | undefined) =>
  invoke(handler, makeEvent({ method: 'GET', path: '/batches', email }));

beforeEach(() => {
  db.reset();
  seedGradingWorld(db); // batches A ("Batch A") and B ("Batch B"); manager and teacher on A, B
  db.addBatch('C', 'Another batch');
});

describe('GET /batches', () => {
  it('gives a super admin every batch, by name', async () => {
    const { status, body } = await call(userOf('SUPER_ADMIN').email);

    expect(status).toBe(200);
    expect(body.batches).toEqual([
      { batchId: 'C', name: 'Another batch' },
      { batchId: 'A', name: 'Batch A' },
      { batchId: 'B', name: 'Batch B' },
    ]);
  });

  it.each([
    ['a batch manager', MANAGER, [{ batchId: 'A', name: 'Batch A' }]],
    ['another batch manager', MANAGER_B, [{ batchId: 'B', name: 'Batch B' }]],
    ['a teacher', TEACHER_A, [{ batchId: 'A', name: 'Batch A' }]],
  ])('gives %s only their assigned batches', async (_who, email, expected) => {
    const { status, body } = await call(email);

    expect(status).toBe(200);
    expect(body.batches).toEqual(expected);
  });

  it('skips an assigned batch that no longer exists, and sorts by name', async () => {
    db.addUser(
      userOf('TEACHER', { email: 'multi@college.edu', batchIds: ['B', 'GONE', 'C', 'A'] }),
    );

    const { body } = await call('multi@college.edu');

    expect(body.batches.map((b: { batchId: string }) => b.batchId)).toEqual(['C', 'A', 'B']);
  });

  it('returns an empty list for staff with no batches', async () => {
    db.addUser(userOf('BATCH_MANAGER', { email: 'new@college.edu' }));

    expect((await call('new@college.edu')).body).toEqual({ batches: [] });
  });

  it.each(deniedRoles('TEACHER', 'BATCH_MANAGER'))('refuses a %s', async (role) => {
    db.addUser(userOf(role, { email: 'denied@college.edu', batchId: 'A', batchIds: ['A'] }));

    expect((await call('denied@college.edu')).status).toBe(403);
  });

  it('answers 401 without an email claim', async () => {
    expect((await call(undefined)).status).toBe(401);
  });

  it('answers 403 for an unknown or deactivated account', async () => {
    db.addUser(userOf('TEACHER', { email: 'off@college.edu', batchIds: ['A'], active: false }));

    expect((await call('nobody@college.edu')).status).toBe(403);
    expect((await call('off@college.edu')).status).toBe(403);
  });
});
