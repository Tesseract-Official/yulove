import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { seedPeople } from '../test-utils/questions.js';
import { handler } from './list-staff.js';

const db = new FakeDb();
const SUPER_ADMIN = userOf('SUPER_ADMIN').email;
const call = (email: string | undefined) =>
  invoke(handler, makeEvent({ method: 'GET', path: '/staff', email }));

beforeEach(() => {
  db.reset();
  seedPeople(db); // super admin, two teachers, a batch manager and a student
});

describe('GET /staff', () => {
  it('lists teachers and batch managers, by name, with their batches', async () => {
    db.addUser(
      userOf('BATCH_MANAGER', { email: 'zed@college.edu', name: 'Zed', batchIds: ['A', 'B'] }),
    );
    db.addUser(userOf('TEACHER', { email: 'amy@college.edu', name: 'Amy', active: false }));

    const { status, body } = await call(SUPER_ADMIN);

    expect(status).toBe(200);
    const names = body.staff.map((s: { name: string }) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(body.staff).toContainEqual({
      email: 'zed@college.edu',
      name: 'Zed',
      role: 'BATCH_MANAGER',
      batchIds: ['A', 'B'],
      active: true,
    });
    // No batches stored: an empty list. A deactivated account is flagged.
    expect(body.staff).toContainEqual({
      email: 'amy@college.edu',
      name: 'Amy',
      role: 'TEACHER',
      batchIds: [],
      active: false,
    });
  });

  it('leaves out students and super admins', async () => {
    const { body } = await call(SUPER_ADMIN);

    const roles = new Set(body.staff.map((s: { role: string }) => s.role));
    expect(roles).toEqual(new Set(['TEACHER', 'BATCH_MANAGER']));
    expect(body.staff).toHaveLength(3); // two teachers and one batch manager
    expect(JSON.stringify(body)).not.toContain('s1@college.edu');
  });

  it('returns an empty list when there is no staff', async () => {
    db.reset();
    db.addUser(userOf('SUPER_ADMIN'));

    expect((await call(SUPER_ADMIN)).body).toEqual({ staff: [] });
  });

  it.each(deniedRoles())('refuses a %s', async (role) => {
    db.addUser(userOf(role, { email: 'denied@college.edu', batchId: 'A', batchIds: ['A'] }));

    const { status } = await call('denied@college.edu');

    expect(status).toBe(403);
  });

  it('answers 401 without an email claim, and 403 for an unknown account', async () => {
    expect((await call(undefined)).status).toBe(401);
    expect((await call('nobody@college.edu')).status).toBe(403);
  });
});
