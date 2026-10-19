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
    ['a student role', { email: 'x@college.edu', name: 'X', role: 'STUDENT' }],
    ['a super admin role', { email: 'x@college.edu', name: 'X', role: 'SUPER_ADMIN' }],
    [
      'an unknown batch',
      { email: 'x@college.edu', name: 'X', role: 'TEACHER', batchIds: ['NOPE'] },
    ],
    ['a bad email', { email: 'nope', name: 'X', role: 'TEACHER' }],
    ['an email with no domain dot', { email: 'x@localhost', name: 'X', role: 'TEACHER' }],
    ['an email with a space inside', { email: 'x y@gmail.com', name: 'X', role: 'TEACHER' }],
    ['a missing name', { email: 'x@college.edu', role: 'TEACHER' }],
    ['no body', undefined],
  ])('answers 422 for %s', async (_label, body) => {
    const before = db.users.size;
    expect((await call(SUPER, body)).status).toBe(422);
    expect(db.users.size).toBe(before);
  });
});

describe('POST /staff: staff may use any email domain', () => {
  it.each([
    ['a teacher with a Gmail address', 'tina@gmail.com', 'TEACHER'],
    ['a teacher on another domain', 'tina@otheruniversity.ac.in', 'TEACHER'],
    ['a batch manager with a Gmail address', 'mo@gmail.com', 'BATCH_MANAGER'],
    ['a batch manager on another domain', 'mo@workspace-company.com', 'BATCH_MANAGER'],
    ['a teacher on a look-alike of the college domain', 'x@college.edu.evil.com', 'TEACHER'],
    ['a teacher on a sub-domain of the college', 'x@mail.college.edu', 'TEACHER'],
  ])('creates %s', async (_label, email, role) => {
    const { status, body } = await call(SUPER, { email, name: 'Person', role, batchIds: ['A'] });

    expect(status).toBe(201);
    expect(body.user).toMatchObject({ email, role, batchIds: ['A'] });
    expect(db.users.get(email)).toMatchObject({ role, active: true });
  });

  it('keeps the address lower case and trimmed', async () => {
    const { status } = await call(SUPER, {
      email: '  Tina@GMAIL.com ',
      name: 'Tina',
      role: 'TEACHER',
    });
    expect(status).toBe(201);
    expect(db.users.has('tina@gmail.com')).toBe(true);
  });

  it('no longer needs the college domain to be configured', async () => {
    delete process.env['COLLEGE_DOMAIN'];
    expect(
      (await call(SUPER, { email: 'tina@gmail.com', name: 'Tina', role: 'TEACHER' })).status,
    ).toBe(201);
  });
});
