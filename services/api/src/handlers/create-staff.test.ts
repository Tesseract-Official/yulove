import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '@yulove/shared/testing';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './create-staff.js';

const db = new FakeDb();
const call = (email: string, body: unknown) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/staff', email, body }));

const SUPER = 'super-admin@college.edu';

beforeEach(() => {
  db.reset();
  process.env['COLLEGE_DOMAIN'] = 'college.edu';
  db.addBatch('A');
  db.addUser(userOf('SUPER_ADMIN'));
  for (const role of deniedRoles()) db.addUser(userOf(role));
});

describe('POST /staff', () => {
  it.each(['TEACHER', 'BATCH_MANAGER'] as const)('creates a %s', async (role) => {
    const { status, body } = await call(SUPER, {
      email: ' New.Person@College.edu ',
      name: 'New Person',
      role,
      batchIds: ['A', 'A'],
    });

    expect(status).toBe(201);
    const expected = {
      email: 'new.person@college.edu',
      role,
      name: 'New Person',
      batchIds: ['A'],
      active: true,
    };
    expect(body.user).toEqual(expected);
    expect(db.users.get('new.person@college.edu')).toEqual(expected);
  });

  it('defaults to no batches', async () => {
    await call(SUPER, { email: 'x@college.edu', name: 'X', role: 'TEACHER' });
    expect(db.users.get('x@college.edu')?.batchIds).toEqual([]);
  });

  it.each(deniedRoles())('refuses a %s with 403 and creates nothing', async (role) => {
    const before = db.users.size;
    const { status } = await call(userOf(role).email, {
      email: 'x@college.edu',
      name: 'X',
      role: 'TEACHER',
    });

    expect(status).toBe(403);
    expect(db.users.size).toBe(before);
  });

  it('answers 409 when the email is already a user', async () => {
    const { status } = await call(SUPER, {
      email: 'teacher@college.edu',
      name: 'Dup',
      role: 'TEACHER',
    });
    expect(status).toBe(409);
  });

  it.each([
    ['an email outside the college domain', { email: 'x@gmail.com', name: 'X', role: 'TEACHER' }],
    ['a look-alike domain', { email: 'x@college.edu.evil.com', name: 'X', role: 'TEACHER' }],
    ['a sub-domain', { email: 'x@mail.college.edu', name: 'X', role: 'TEACHER' }],
    ['a student role', { email: 'x@college.edu', name: 'X', role: 'STUDENT' }],
    ['a super admin role', { email: 'x@college.edu', name: 'X', role: 'SUPER_ADMIN' }],
    [
      'an unknown batch',
      { email: 'x@college.edu', name: 'X', role: 'TEACHER', batchIds: ['NOPE'] },
    ],
    ['a bad email', { email: 'nope', name: 'X', role: 'TEACHER' }],
    ['a missing name', { email: 'x@college.edu', role: 'TEACHER' }],
    ['no body', undefined],
  ])('answers 422 for %s', async (_label, body) => {
    const before = db.users.size;
    expect((await call(SUPER, body)).status).toBe(422);
    expect(db.users.size).toBe(before);
  });
});
