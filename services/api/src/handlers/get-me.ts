import { ROLES, type MeResponse } from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { batchesFor } from '../lib/batches.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** GET /me: the current user, their role and their batches. Every role may call it. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ROLES);

  const batches = await batchesFor(user);

  const body: MeResponse = {
    email: user.email,
    name: user.name,
    role: user.role,
    rollNo: user.rollNo,
    batchId: user.batchId,
    batchIds: user.batchIds,
    batches,
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
