import {
  assignBatchesBody,
  normaliseEmail,
  NotFoundError,
  parseBody,
  ValidationError,
} from '@yulove/shared';
import { requireUser, usersDb } from '@yulove/shared/server';
import { assertBatchesExist } from '../lib/batches.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/** PUT /staff/{email}/batches (super admin): set the batches of a teacher or batch manager. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  await requireUser(event, []);
  const email = normaliseEmail(pathParam(event, 'email'));
  const body = parseBody(assignBatchesBody, event);

  const target = await usersDb.getUser(email);
  if (!target) throw new NotFoundError(`No user ${email}`);
  if (target.role !== 'TEACHER' && target.role !== 'BATCH_MANAGER') {
    throw new ValidationError('Only teachers and batch managers can be assigned to batches');
  }

  const batchIds = [...new Set(body.batchIds)];
  await assertBatchesExist(batchIds);

  const updated = await usersDb.updateUser(email, { batchIds });
  if (!updated) throw new NotFoundError(`No user ${email}`);
  return { status: 200, body: { user: { ...target, batchIds } } };
}

export const handler = apiHandler(handle);
