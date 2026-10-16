import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '../test-utils/fake-db.js';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './assign-batches.js';

const db = new FakeDb();
const call = (caller: string, target: string, body: unknown) =>
  invoke(
    handler,
    makeEvent({
      method: 'PUT',
      path: `/staff/${target}/batches`,
      email: caller,
      pathParameters: { email: encodeURIComponent(target) },
      body,
    }),
  );

const SUPER = 'super-admin@college.edu';

beforeEach(() => {
  db.reset();
  db.addBatch('A');
  db.addBatch('B');
  db.addUser(userOf('SUPER_ADMIN'));
  db.addUser(userOf('TEACHER', { email: 'teacher@college.edu', batchIds: ['A'] }));
  db.addUser(userOf('BATCH_MANAGER', { email: 'manager@college.edu', batchIds: [] }));
  db.addUser(userOf('STUDENT', { email: 'student@college.edu', batchId: 'A' }));
});

describe('PUT /staff/{email}/batches', () => {
  it.each([
    ['teacher@college.edu', 'TEACHER'],
    ['manager@college.edu', 'BATCH_MANAGER'],
  ])('assigns batches to %s', async (target) => {
    const { status, body } = await call(SUPER, target, { batchIds: ['B', 'A', 'B'] });

    expect(status).toBe(200);
    expect(body.user.batchIds).toEqual(['B', 'A']);
    expect(db.users.get(target)?.batchIds).toEqual(['B', 'A']);
  });

  it('replaces the list, so an empty list unassigns everything', async () => {
    await call(SUPER, 'teacher@college.edu', { batchIds: [] });
    expect(db.users.get('teacher@college.edu')?.batchIds).toEqual([]);
  });

  it('accepts the email in any case', async () => {
    const { status } = await call(SUPER, 'Teacher@College.EDU', { batchIds: ['B'] });
    expect(status).toBe(200);
    expect(db.users.get('teacher@college.edu')?.batchIds).toEqual(['B']);
  });

  it.each(deniedRoles())('refuses a %s with 403 and changes nothing', async (role) => {
    const { status } = await call(userOf(role).email, 'manager@college.edu', { batchIds: ['A'] });

    expect(status).toBe(403);
    expect(db.users.get('manager@college.edu')?.batchIds).toEqual([]);
  });

  it.each([
    ['a student', 'student@college.edu'],
    ['a super admin', SUPER],
  ])('answers 422 when the target is %s', async (_label, target) => {
    const before = structuredClone(db.users.get(target));
    expect((await call(SUPER, target, { batchIds: ['A'] })).status).toBe(422);
    expect(db.users.get(target)).toEqual(before);
  });

  it('answers 422 when any batch does not exist, naming it, and changes nothing', async () => {
    const { status, body } = await call(SUPER, 'teacher@college.edu', { batchIds: ['A', 'NOPE'] });

    expect(status).toBe(422);
    expect(body.error.message).toContain('NOPE');
    expect(db.users.get('teacher@college.edu')?.batchIds).toEqual(['A']);
  });

  it('answers 404 when the user does not exist', async () => {
    expect((await call(SUPER, 'ghost@college.edu', { batchIds: ['A'] })).status).toBe(404);
  });

  it.each([
    ['batchIds that is not a list', { batchIds: 'A' }],
    ['a missing batchIds', {}],
    ['an invalid batch id', { batchIds: ['not valid!'] }],
    ['no body', undefined],
  ])('answers 422 for %s', async (_label, body) => {
    expect((await call(SUPER, 'teacher@college.edu', body)).status).toBe(422);
  });
});
