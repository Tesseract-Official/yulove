import { describe, expect, it } from 'vitest';
import { isOnDomain, signInProblem, STAFF_SIGN_IN_ROLES } from './sign-in.js';

const COLLEGE = 'college.edu';
const active = (role: 'TEACHER' | 'BATCH_MANAGER' | 'SUPER_ADMIN' | 'STUDENT') => ({
  role,
  active: true,
});

describe('isOnDomain', () => {
  it.each([
    ['a@college.edu', true],
    ['A@College.EDU ', true],
    ['a@mail.college.edu', false],
    ['a@college.edu.evil.com', false],
    ['a@notcollege.edu', false],
    ['a@gmail.com', false],
  ])('%s → %s', (email, expected) => {
    expect(isOnDomain(email, COLLEGE)).toBe(expected);
    expect(isOnDomain(email, ' College.EDU ')).toBe(expected);
  });
});

describe('signInProblem', () => {
  it('names the staff roles that may use any address', () => {
    expect([...STAFF_SIGN_IN_ROLES].sort()).toEqual(['BATCH_MANAGER', 'SUPER_ADMIN', 'TEACHER']);
  });

  it.each(['TEACHER', 'BATCH_MANAGER', 'SUPER_ADMIN'] as const)(
    'lets an active %s in with any address',
    (role) => {
      for (const email of ['a@gmail.com', 'a@elsewhere.org', 'a@college.edu']) {
        expect(signInProblem(active(role), email, COLLEGE)).toBeUndefined();
      }
    },
  );

  it('lets an active student in only on the college domain', () => {
    expect(signInProblem(active('STUDENT'), 'a@college.edu', COLLEGE)).toBeUndefined();
    for (const email of ['a@gmail.com', 'a@elsewhere.org', 'a@mail.college.edu']) {
      expect(signInProblem(active('STUDENT'), email, COLLEGE)).toMatch(/college email/);
    }
  });

  it.each(['TEACHER', 'BATCH_MANAGER', 'SUPER_ADMIN', 'STUDENT'] as const)(
    'refuses an inactive %s',
    (role) => {
      expect(signInProblem({ role, active: false }, 'a@college.edu', COLLEGE)).toMatch(/inactive/);
    },
  );

  it('treats a record with no active flag as active', () => {
    expect(signInProblem({ role: 'TEACHER' } as never, 'a@gmail.com', COLLEGE)).toBeUndefined();
  });

  it('refuses someone who is not registered', () => {
    expect(signInProblem(undefined, 'a@college.edu', COLLEGE)).toMatch(/not been registered/);
  });

  it('refuses a role it does not know', () => {
    expect(
      signInProblem({ role: 'VISITOR', active: true } as never, 'a@gmail.com', COLLEGE),
    ).toMatch(/cannot sign in/);
  });
});
