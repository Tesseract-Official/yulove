import type { Role } from './enums.js';
import type { Override } from './types.js';

/**
 * What non-super-admins may know about a super admin's actions: nothing. A super admin's action is
 * applied normally and audited, but its trace (who, role, entry) never leaves the API for anyone
 * else. These are the pure rules; the lookups that need the Users table are in ./actors.ts.
 */

/** Whether the viewer is allowed to see super admin actions. */
export const seesSuperAdminActions = (viewer: Role): boolean => viewer === 'SUPER_ADMIN';

/**
 * Whether an override counts as a teacher's. Overrides with no stored role are from before
 * teachers could override, so a super admin made them.
 */
export const isTeacherOverride = (override: Override | undefined): boolean =>
  override?.byRole === 'TEACHER';

/** The override as the viewer may see it: a super admin's override is invisible to everyone else. */
export function overrideVisibleTo(
  viewer: Role,
  override: Override | undefined,
): Override | undefined {
  if (!override) return undefined;
  return seesSuperAdminActions(viewer) || isTeacherOverride(override) ? override : undefined;
}

/**
 * Whether an audit entry made by an actor with this role is visible to the viewer. Entries with
 * no stored role are from before teachers could override, so a super admin made them.
 */
export function auditEntryVisibleTo(viewer: Role, actorRole: Role | undefined): boolean {
  return seesSuperAdminActions(viewer) || (actorRole !== undefined && actorRole !== 'SUPER_ADMIN');
}
