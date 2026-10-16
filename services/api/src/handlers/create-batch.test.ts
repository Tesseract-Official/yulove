import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '../test-utils/fake-db.js';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './create-batch.js';

const db = new FakeDb();
const call = (email: string, body: unknown) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/batches', email, body }));

beforeEach(() => {
  db.reset();
  db.addUser(userOf('SUPER_ADMIN'));
  for (const role of deniedRoles())
    db.addUser(userOf(role, { batchIds: ['2026-A'], batchId: '2026-A' }));
});

describe('POST /batches', () => {
  it('lets a super admin create a batch', async () => {
    const { status, body } = await call('super-admin@college.edu', {
      batchId: '2026-A',
      name: 'CSE A',
    });

    expect(status).toBe(201);
    expect(body.batch).toEqual({ batchId: '2026-A', name: 'CSE A' });
    expect(db.batches.get('2026-A')).toEqual({ batchId: '2026-A', name: 'CSE A' });
  });

  it.each(deniedRoles())('refuses a %s with 403 and creates nothing', async (role) => {
    const { status } = await call(userOf(role).email, { batchId: 'NEW', name: 'New' });

    expect(status).toBe(403);
    expect(db.batches.size).toBe(0);
  });

  it('answers 409 for a duplicate id', async () => {
    db.addBatch('2026-A');
    expect(
      (await call('super-admin@college.edu', { batchId: '2026-A', name: 'Again' })).status,
    ).toBe(409);
  });

  it.each([
    ['an id with spaces', { batchId: 'bad id', name: 'x' }],
    ['an empty name', { batchId: 'ok', name: ' ' }],
    ['a missing id', { name: 'x' }],
    ['no body', undefined],
    ['a non-JSON body', 'not json'],
  ])('answers 422 for %s', async (_label, body) => {
    expect((await call('super-admin@college.edu', body)).status).toBe(422);
    expect(db.batches.size).toBe(0);
  });
});
