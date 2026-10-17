import type { BatchListResponse } from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { batchesFor } from '../lib/batches.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /batches (teacher, batch manager): the batches the caller works with, by name. A super admin
 * gets every batch; anyone else gets only the batches they are assigned to.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ['TEACHER', 'BATCH_MANAGER']);

  const batches = (await batchesFor(user))
    .map(({ batchId, name }) => ({ batchId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const body: BatchListResponse = { batches };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
