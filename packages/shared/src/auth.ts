import type { Role } from './enums.js';
import { getUser } from './db/users.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';
import { normaliseEmail } from './identity.js';
import type { UserItem } from './types.js';

/** The part of an API Gateway HTTP API event (JWT authorizer) that auth reads. */
export interface AuthEvent {
  requestContext: {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } } | undefined;
  };
}

export interface AuthContext {
  user: UserItem;
  /** SUPER_ADMIN: any batch. Teacher and batch manager: their batchIds. Student: their batchId. */
  canAccessBatch(batchId: string): boolean;
  /** Throws ForbiddenError (403) when canAccessBatch is false. */
  assertBatchAccess(batchId: string): void;
}

export function canUserAccessBatch(user: UserItem, batchId: string): boolean {
  switch (user.role) {
    case 'SUPER_ADMIN':
      return true;
    case 'TEACHER':
    case 'BATCH_MANAGER':
      return user.batchIds?.includes(batchId) ?? false;
    case 'STUDENT':
      return user.batchId !== undefined && user.batchId === batchId;
  }
}

/** Users already loaded for a request, so the API wrapper does not read the same row again. */
const loadedUsers = new WeakMap<object, UserItem>();

/**
 * The caller of this request. Reuses the user `requireUser` loaded; otherwise reads the Users
 * table with the JWT's email claim. Undefined when there is no usable claim or no such user.
 * Does not check the role or whether the account is active.
 */
export async function findCaller(event: AuthEvent): Promise<UserItem | undefined> {
  const cached = loadedUsers.get(event);
  if (cached) return cached;
  let email: string;
  try {
    email = emailClaim(event);
  } catch {
    return undefined;
  }
  const user = await getUser(email);
  if (user) loadedUsers.set(event, user);
  return user;
}

function emailClaim(event: AuthEvent): string {
  const claim = event.requestContext.authorizer?.jwt?.claims?.['email'];
  if (typeof claim !== 'string' || claim.trim() === '') {
    throw new UnauthorizedError('Token has no email claim');
  }
  return normaliseEmail(claim);
}

/**
 * Every API handler calls this first. Reads the email claim from the JWT, loads the user from
 * the Users table (the role never comes from the client), and checks the role.
 *
 * - no email claim: 401
 * - not in Users, or `active` is false: 403 (the pre-sign-up check only runs on first sign-in)
 * - role not in `allowedRoles`: 403. SUPER_ADMIN always passes.
 */
export async function requireUser(
  event: AuthEvent,
  allowedRoles: readonly Role[],
): Promise<AuthContext> {
  const email = emailClaim(event);

  const user = await getUser(email);
  if (!user) throw new ForbiddenError('This account is not registered');
  loadedUsers.set(event, user);
  if (user.active === false) throw new ForbiddenError('This account is deactivated');

  if (user.role !== 'SUPER_ADMIN' && !allowedRoles.includes(user.role)) {
    throw new ForbiddenError('Your role cannot do this');
  }

  const canAccessBatch = (batchId: string) => canUserAccessBatch(user, batchId);
  return {
    user,
    canAccessBatch,
    assertBatchAccess(batchId: string) {
      if (!canAccessBatch(batchId))
        throw new ForbiddenError('You do not have access to this batch');
    },
  };
}
