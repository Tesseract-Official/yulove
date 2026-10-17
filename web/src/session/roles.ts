import type { Role } from '@yulove/shared';

/** Where each role lands after signing in. */
export const ROLE_HOME: Record<Role, string> = {
  SUPER_ADMIN: '/admin',
  BATCH_MANAGER: '/manager',
  TEACHER: '/teacher',
  STUDENT: '/student',
};

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Admin',
  BATCH_MANAGER: 'Batch manager',
  TEACHER: 'Teacher',
  STUDENT: 'Student',
};

const SECTION_ORDER: readonly Role[] = ['SUPER_ADMIN', 'BATCH_MANAGER', 'TEACHER', 'STUDENT'];

/** The sections a role may open: a super admin can open every one, everyone else only their own. */
export function allowedSections(role: Role): readonly Role[] {
  return role === 'SUPER_ADMIN' ? SECTION_ORDER : [role];
}
