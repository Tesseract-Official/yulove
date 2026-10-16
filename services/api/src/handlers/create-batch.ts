import { createBatchBody, parseBody } from '@yulove/shared';
import { batchesDb, requireUser } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** POST /batches (super admin). */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  await requireUser(event, []);
  const body = parseBody(createBatchBody, event);

  const batch = { batchId: body.batchId, name: body.name };
  await batchesDb.createBatch(batch); // 409 if the id is taken
  return { status: 201, body: { batch } };
}

export const handler = apiHandler(handle);
