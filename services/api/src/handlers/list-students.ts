import { NotFoundError, ValidationError } from '@yulove/shared';
import { batchesDb, requireUser, usersDb } from '@yulove/shared/server';
import { apiHandler, pathParam, queryParam, type ApiEvent, type ApiResult } from '../lib/http.js';

const MAX_SEARCH_LENGTH = 100;

/**
 * GET /batches/{batchId}/students?search= (batch manager, teacher): the batch's students,
 * optionally filtered by roll number, name or email (case-insensitive, substring).
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER', 'TEACHER']);
  const batchId = pathParam(event, 'batchId');
  ctx.assertBatchAccess(batchId);

  const search = (queryParam(event, 'search') ?? '').trim().toLowerCase();
  if (search.length > MAX_SEARCH_LENGTH) {
    throw new ValidationError(`search must be at most ${MAX_SEARCH_LENGTH} characters`);
  }

  if (!(await batchesDb.getBatch(batchId))) throw new NotFoundError(`No batch ${batchId}`);

  const students = (await usersDb.listUsersByBatch(batchId))
    .filter((u) => u.role === 'STUDENT')
    .filter(
      (u) =>
        search === '' ||
        (u.rollNo ?? '').toLowerCase().includes(search) ||
        u.name.toLowerCase().includes(search) ||
        u.email.includes(search),
    )
    .sort((a, b) => (a.rollNo ?? '').localeCompare(b.rollNo ?? '', undefined, { numeric: true }))
    .map((u) => ({
      email: u.email,
      name: u.name,
      rollNo: u.rollNo,
      batchId: u.batchId,
      active: u.active,
    }));

  return { status: 200, body: { students } };
}

export const handler = apiHandler(handle);
