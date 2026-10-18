import type { AuditLogItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './set-user-active.js';

const db = new FakeDb();

const SUPER = 'super-admin@college.edu';
const OTHER_SUPER = 'founder-two@gmail.com';
const MANAGER_A = 'manager-a@college.edu';
const MANAGER_B = 'manager-b@college.edu';
const STUDENT_A = 'student-a@college.edu';
const STUDENT_B = 'student-b@college.edu';
const TEACHER = 'teacher@college.edu';

const call = (caller: string | undefined, target: string, body: unknown) =>
  invoke(
    handler,
    makeEvent({
      method: 'PUT',
      path: `/users/${target}/active`,
      email: caller,
      pathParameters: { email: encodeURIComponent(target) },
      body,
    }),
  );

const off = { active: false, reason: 'Left the college' };
const on = { active: true, reason: 'Came back' };

const activeOf = (email: string) => db.users.get(email)?.active;
const userAudits = () =>
  db.all<AuditLogItem>('AuditLog').filter((e) => e.entityKey.startsWith('user#'));

beforeEach(() => {
  db.reset();
  db.addBatch('A');
  db.addBatch('B');
  db.addUser(userOf('SUPER_ADMIN'));
  db.addUser(userOf('SUPER_ADMIN', { email: OTHER_SUPER }));
  db.addUser(userOf('BATCH_MANAGER', { email: MANAGER_A, batchIds: ['A'] }));
  db.addUser(userOf('BATCH_MANAGER', { email: MANAGER_B, batchIds: ['B'] }));
  db.addUser(userOf('TEACHER', { email: TEACHER, batchIds: ['A'] }));
  db.addUser(userOf('STUDENT', { email: STUDENT_A, batchId: 'A', rollNo: 'R1' }));
  db.addUser(userOf('STUDENT', { email: STUDENT_B, batchId: 'B', rollNo: 'R2' }));
});

describe('PUT /users/{email}/active as a super admin', () => {
  it.each([TEACHER, MANAGER_A, STUDENT_A, OTHER_SUPER])('deactivates %s', async (target) => {
    const { status, body } = await call(SUPER, target, off);

    expect(status).toBe(200);
    expect(body).toMatchObject({ user: { email: target, active: false }, changed: true });
    expect(activeOf(target)).toBe(false);
  });

  it('reactivates someone who was switched off', async () => {
    await call(SUPER, STUDENT_A, off);

    const { status, body } = await call(SUPER, STUDENT_A, on);

    expect(status).toBe(200);
    expect(body).toMatchObject({ user: { active: true }, changed: true });
    expect(activeOf(STUDENT_A)).toBe(true);
  });

  it('accepts the email in any case', async () => {
    const { status } = await call(SUPER, 'Student-A@College.EDU', off);
    expect(status).toBe(200);
    expect(activeOf(STUDENT_A)).toBe(false);
  });

  it('keeps everything else about the person', async () => {
    const before = db.users.get(TEACHER);
    await call(SUPER, TEACHER, off);
    expect(db.users.get(TEACHER)).toEqual({ ...before, active: false });
  });

  it('answers 404 for someone who does not exist', async () => {
    expect((await call(SUPER, 'nobody@college.edu', off)).status).toBe(404);
  });

  it('changes nothing and records nothing when the person is already in that state', async () => {
    const { status, body } = await call(SUPER, STUDENT_A, on);

    expect(status).toBe(200);
    expect(body.changed).toBe(false);
    expect(userAudits()).toEqual([]);
  });

  it('treats an account with no active flag as active', async () => {
    const legacy = db.users.get(STUDENT_A);
    delete (legacy as { active?: boolean }).active;

    const { body } = await call(SUPER, STUDENT_A, on);
    expect(body.changed).toBe(false);
    expect((await call(SUPER, STUDENT_A, off)).body.changed).toBe(true);
  });
});

describe('PUT /users/{email}/active: the audit entry', () => {
  it('records who, what, the old and new state and the reason', async () => {
    await call(SUPER, STUDENT_A, off);

    expect(userAudits()).toHaveLength(1);
    expect(userAudits()[0]).toMatchObject({
      entityKey: `user#${STUDENT_A}`,
      actor: SUPER,
      action: 'DEACTIVATE_USER',
      before: { active: true },
      after: { active: false },
      reason: 'Left the college',
    });
    expect(Date.parse(userAudits()[0]?.timestamp ?? '')).not.toBeNaN();
  });

  it('records a reactivation as its own entry, after the first', async () => {
    await call(SUPER, STUDENT_A, off);
    await call(SUPER, STUDENT_A, { active: true, reason: 'Came back' });

    expect(userAudits().map((e) => e.action)).toEqual(['DEACTIVATE_USER', 'REACTIVATE_USER']);
    expect(userAudits()[1]).toMatchObject({
      before: { active: false },
      after: { active: true },
      reason: 'Came back',
    });
  });

  it('also records the request itself for a super admin, by the wrapper', async () => {
    await call(SUPER, STUDENT_A, off);

    const request = db
      .all<AuditLogItem>('AuditLog')
      .find((e) => e.entityKey.startsWith('request#'));
    expect(request).toMatchObject({
      actor: SUPER,
      method: 'PUT',
      statusCode: 200,
      outcome: 'success',
    });
  });

  it('records a batch manager’s change under their own name', async () => {
    await call(MANAGER_A, STUDENT_A, off);
    expect(userAudits()[0]).toMatchObject({ actor: MANAGER_A, action: 'DEACTIVATE_USER' });
  });

  it('records nothing when the change is refused', async () => {
    await call(MANAGER_B, STUDENT_A, off);
    await call(SUPER, SUPER, off);
    await call(SUPER, STUDENT_A, { active: false });
    expect(userAudits()).toEqual([]);
  });
});

describe('PUT /users/{email}/active: the reason', () => {
  it.each([
    ['missing', { active: false }],
    ['empty', { active: false, reason: '' }],
    ['blank', { active: false, reason: '   ' }],
    ['too long', { active: false, reason: 'x'.repeat(1001) }],
    ['missing on a reactivation', { active: true }],
  ])('answers 422 when the reason is %s, and changes nothing', async (_label, body) => {
    expect((await call(SUPER, STUDENT_A, body)).status).toBe(422);
    expect(activeOf(STUDENT_A)).toBe(true);
    expect(userAudits()).toEqual([]);
  });

  it.each([
    ['no active flag', { reason: 'why' }],
    ['a text flag', { active: 'no', reason: 'why' }],
  ])('answers 422 with %s', async (_label, body) => {
    expect((await call(SUPER, STUDENT_A, body)).status).toBe(422);
  });
});

describe('PUT /users/{email}/active: who may call', () => {
  it.each(deniedRoles('BATCH_MANAGER').filter((r) => r !== 'STUDENT'))(
    'refuses a %s with 403',
    async (role) => {
      const { status } = await call(userOf(role).email, STUDENT_A, off);
      expect(status).toBe(403);
      expect(activeOf(STUDENT_A)).toBe(true);
    },
  );

  it('refuses a student with 403', async () => {
    expect((await call(STUDENT_B, STUDENT_A, off)).status).toBe(403);
    expect(activeOf(STUDENT_A)).toBe(true);
  });

  it('answers 401 without a signed-in identity', async () => {
    expect((await call(undefined, STUDENT_A, off)).status).toBe(401);
  });

  it('refuses someone who is deactivated, even a former super admin', async () => {
    db.users.get(SUPER)!.active = false;
    expect((await call(SUPER, STUDENT_A, off)).status).toBe(403);
    expect(activeOf(STUDENT_A)).toBe(true);
  });

  it('refuses an unregistered account', async () => {
    expect((await call('stranger@college.edu', STUDENT_A, off)).status).toBe(403);
  });

  it('a deactivated person is then refused by every route', async () => {
    await call(SUPER, MANAGER_A, off);
    expect((await call(MANAGER_A, STUDENT_A, off)).status).toBe(403);
    expect(activeOf(STUDENT_A)).toBe(true);
  });
});

describe('PUT /users/{email}/active as a batch manager', () => {
  it('switches a student of their own batch off and on again', async () => {
    expect((await call(MANAGER_A, STUDENT_A, off)).status).toBe(200);
    expect(activeOf(STUDENT_A)).toBe(false);

    expect((await call(MANAGER_A, STUDENT_A, on)).status).toBe(200);
    expect(activeOf(STUDENT_A)).toBe(true);
  });

  it('may not touch a student of another batch (403), and nothing changes', async () => {
    const { status } = await call(MANAGER_A, STUDENT_B, off);

    expect(status).toBe(403);
    expect(activeOf(STUDENT_B)).toBe(true);
    expect(userAudits()).toEqual([]);
  });

  it('may not reactivate a student of another batch either', async () => {
    db.users.get(STUDENT_B)!.active = false;
    expect((await call(MANAGER_A, STUDENT_B, on)).status).toBe(403);
    expect(activeOf(STUDENT_B)).toBe(false);
  });

  it.each([
    ['a teacher', TEACHER],
    ['another batch manager', MANAGER_B],
    ['a super admin', SUPER],
  ])('may not touch %s (403)', async (_label, target) => {
    const before = db.users.get(target)?.active;
    expect((await call(MANAGER_A, target, off)).status).toBe(403);
    expect(db.users.get(target)?.active).toBe(before);
  });

  it('may not touch a student who is in no batch (403)', async () => {
    db.addUser(userOf('STUDENT', { email: 'floating@college.edu' }));
    expect((await call(MANAGER_A, 'floating@college.edu', off)).status).toBe(403);
  });

  it('may not touch themselves (403, they are not a student)', async () => {
    expect((await call(MANAGER_A, MANAGER_A, off)).status).toBe(403);
    expect(activeOf(MANAGER_A)).toBe(true);
  });

  it('must still give a reason', async () => {
    expect((await call(MANAGER_A, STUDENT_A, { active: false })).status).toBe(422);
    expect(activeOf(STUDENT_A)).toBe(true);
  });

  it('is limited to the batches they are assigned to now', async () => {
    db.users.get(MANAGER_A)!.batchIds = ['B'];
    expect((await call(MANAGER_A, STUDENT_A, off)).status).toBe(403);
    expect((await call(MANAGER_A, STUDENT_B, off)).status).toBe(200);
  });
});

describe('PUT /users/{email}/active: protecting the founders', () => {
  it('a super admin cannot deactivate themselves (409), and nothing changes', async () => {
    const { status, body } = await call(SUPER, SUPER, off);

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/your own account/);
    expect(activeOf(SUPER)).toBe(true);
    expect(userAudits()).toEqual([]);
  });

  it('the self check applies in any case of the email', async () => {
    expect((await call(SUPER, 'SUPER-ADMIN@College.edu', off)).status).toBe(409);
  });

  it('a super admin alone still cannot switch themselves off', async () => {
    db.users.get(OTHER_SUPER)!.active = false;
    expect((await call(SUPER, SUPER, off)).status).toBe(409);
    expect(activeOf(SUPER)).toBe(true);
  });

  it('one founder can switch the other off while they stay active', async () => {
    expect((await call(SUPER, OTHER_SUPER, off)).status).toBe(200);
    expect(activeOf(SUPER)).toBe(true);
  });

  it('never leaves nobody: if both switch each other off at the same moment, the second is put back', async () => {
    // The other founder's own change lands between this request's check and its re-check.
    db.onPut = (table, item) => {
      if (table === 'AuditLog' && String(item['entityKey']).startsWith('user#')) {
        db.users.get(SUPER)!.active = false;
      }
    };

    const { status, body } = await call(SUPER, OTHER_SUPER, off);
    db.onPut = undefined;

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/last active super admin/);
    expect(activeOf(OTHER_SUPER)).toBe(true);
    expect(userAudits().map((e) => e.action)).toEqual(['DEACTIVATE_USER', 'REACTIVATE_USER']);
    expect(userAudits()[1]?.reason).toMatch(/no active super admin/);
  });

  it('can switch a founder back on', async () => {
    await call(SUPER, OTHER_SUPER, off);
    expect((await call(SUPER, OTHER_SUPER, on)).status).toBe(200);
    expect(activeOf(OTHER_SUPER)).toBe(true);
  });
});
