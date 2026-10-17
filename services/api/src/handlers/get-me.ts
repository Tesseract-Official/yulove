import { ROLES, type BatchItem, type MeResponse, mapLimit } from '@yulove/shared';
import { batchesDb, requireUser } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** GET /me: the current user, their role and their batches. Every role may call it. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ROLES);

  let batches: BatchItem[];
  if (user.role === 'SUPER_ADMIN') {
    batches = (await batchesDb.listBatches()).sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const ids = user.role === 'STUDENT' ? [user.batchId] : (user.batchIds ?? []);
    const found = await mapLimit(
      ids.filter((id): id is string => id !== undefined),
      10,
      (id) => batchesDb.getBatch(id),
    );
    batches = found.filter((b): b is BatchItem => b !== undefined);
  }

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
