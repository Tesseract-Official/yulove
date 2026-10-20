import { getUser } from './db/users.js';
import type { Role } from './enums.js';
import { normaliseEmail } from './identity.js';
import { seesSuperAdminActions } from './visibility.js';

/**
 * Decides whether an email that was stored without a role (an exam's createdBy, an appeal's
 * handledBy, ...) belongs to a super admin, so a response can leave it out. One Users lookup per
 * distinct email per resolver; make a resolver per request. An email with no Users record is
 * treated as hidden: better to omit a name than to show a founder's.
 */
export function makeActorResolver(viewer: Role): {
  /** The email, or undefined when the viewer may not see who this was. */
  visible(email: string | undefined): Promise<string | undefined>;
} {
  const cache = new Map<string, Promise<boolean>>();
  const isSuperAdmin = (email: string): Promise<boolean> => {
    const key = normaliseEmail(email);
    let found = cache.get(key);
    if (!found) {
      found = getUser(key).then((u) => u === undefined || u.role === 'SUPER_ADMIN');
      cache.set(key, found);
    }
    return found;
  };
  return {
    async visible(email) {
      if (email === undefined) return undefined;
      if (seesSuperAdminActions(viewer)) return email;
      return (await isSuperAdmin(email)) ? undefined : email;
    },
  };
}
