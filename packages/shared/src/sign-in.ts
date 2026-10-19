import type { Role } from './enums.js';
import { normaliseEmail } from './identity.js';
import type { UserItem } from './types.js';

/** Roles whose people may sign in with any Google account. */
export const STAFF_SIGN_IN_ROLES: readonly Role[] = ['SUPER_ADMIN', 'TEACHER', 'BATCH_MANAGER'];

/** True for an address on exactly `@<domain>` (sub-domains and look-alikes do not count). */
export function isOnDomain(email: string, domain: string): boolean {
  return normaliseEmail(email).endsWith(`@${domain.trim().toLowerCase()}`);
}

/**
 * Why this person may not sign in, or undefined when they may. The decision comes only from their
 * Users record: it must exist and be active; staff (super admin, teacher, batch manager) may use
 * any email address, students only one on the college domain. Nothing the sign-in request says
 * about the person's role or domain is used.
 */
export function signInProblem(
  user: Pick<UserItem, 'role' | 'active'> | undefined,
  email: string,
  collegeDomain: string,
): string | undefined {
  if (!user) return 'This email has not been registered. Ask an admin or your batch manager.';
  if (user.active === false) return 'This account has been made inactive.';
  if (STAFF_SIGN_IN_ROLES.includes(user.role)) return undefined;
  if (user.role === 'STUDENT') {
    return isOnDomain(email, collegeDomain)
      ? undefined
      : 'Students must sign in with their college email address.';
  }
  return 'This account cannot sign in.';
}
