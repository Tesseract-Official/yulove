import {
  ConflictError,
  ForbiddenError,
  normaliseEmail,
  NotFoundError,
  parseBody,
  setActiveBody,
  type SetActiveResponse,
  type UserItem,
} from '@yulove/shared';
import { requireUser, usersDb, userEntityKey, writeAudit } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

const isActive = (user: UserItem) => user.active !== false;

/** The super admins other than `except` who can still sign in. */
async function otherActiveSuperAdmins(except: string): Promise<UserItem[]> {
  return (await usersDb.listSuperAdmins()).filter((u) => u.email !== except && isActive(u));
}

/**
 * PUT /users/{email}/active (super admin, batch manager): switches a person off or on again. A
 * switched-off person is refused by every route (requireUser) but keeps all their data.
 *  - a super admin may change anyone, but not themselves, and never the last active super admin;
 *  - a batch manager may change only students of their own batches;
 *  - a reason is always required, and every change is written to the audit log.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const email = normaliseEmail(pathParam(event, 'email'));
  const body = parseBody(setActiveBody, event);

  const target = await usersDb.getUser(email);
  if (!target) throw new NotFoundError(`No user ${email}`);

  if (ctx.user.role !== 'SUPER_ADMIN') {
    if (target.role !== 'STUDENT') {
      throw new ForbiddenError('Batch managers can only switch students on or off');
    }
    ctx.assertBatchAccess(target.batchId ?? '');
  }

  if (!body.active && target.email === ctx.user.email) {
    throw new ConflictError('You cannot deactivate your own account');
  }

  const respond = (active: boolean, changed: boolean): ApiResult => {
    const response: SetActiveResponse = {
      user: { email: target.email, name: target.name, role: target.role, active },
      changed,
    };
    return { status: 200, body: response };
  };

  const before = isActive(target);
  if (before === body.active) return respond(before, false);

  const guardsLastAdmin = !body.active && target.role === 'SUPER_ADMIN';
  if (guardsLastAdmin && (await otherActiveSuperAdmins(target.email)).length === 0) {
    throw new ConflictError('This is the last active super admin, so it cannot be deactivated');
  }

  // Written first: no change to who can sign in goes unrecorded.
  await writeAudit(
    userEntityKey(target.email),
    ctx.user.email,
    body.active ? 'REACTIVATE_USER' : 'DEACTIVATE_USER',
    { active: before },
    { active: body.active },
    body.reason,
    undefined,
    ctx.user.role,
  );
  if (!(await usersDb.updateUser(target.email, { active: body.active }))) {
    throw new NotFoundError(`No user ${email}`);
  }

  // Two super admins switching each other off at the same moment would both pass the check above.
  // Look again; if nobody is left, put this one back.
  if (guardsLastAdmin && (await otherActiveSuperAdmins(target.email)).length === 0) {
    await usersDb.updateUser(target.email, { active: true });
    await writeAudit(
      userEntityKey(target.email),
      ctx.user.email,
      'REACTIVATE_USER',
      { active: false },
      { active: true },
      'Undone automatically: it would have left no active super admin',
      undefined,
      ctx.user.role,
    );
    throw new ConflictError('This is the last active super admin, so it cannot be deactivated');
  }

  return respond(body.active, true);
}

export const handler = apiHandler(handle);
