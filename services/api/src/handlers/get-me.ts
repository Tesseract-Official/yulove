import { ROLES, type BatchItem } from '@yulove/shared';
import { batchesDb, requireUser } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';
import { mapLimit } from '../lib/concurrency.js';

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

  return {
    status: 200,
    body: {
      email: user.email,
      name: user.name,
      role: user.role,
      rollNo: user.rollNo,
      batchId: user.batchId,
      batchIds: user.batchIds,
      batches,
    },
  };
}

export const handler = apiHandler(handle);
