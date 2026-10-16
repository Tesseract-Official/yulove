import { createStaffBody, parseBody, ValidationError, type UserItem } from '@yulove/shared';
import { requireUser, usersDb } from '@yulove/shared/server';
import { assertBatchesExist } from '../lib/batches.js';
import { collegeEmailProblem, requireCollegeDomain } from '../lib/college-email.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** POST /staff (super admin): create a teacher or batch manager. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  await requireUser(event, []);
  const body = parseBody(createStaffBody, event);

  const problem = collegeEmailProblem(body.email, requireCollegeDomain());
  if (problem) throw new ValidationError(`Email: ${problem}`);

  const batchIds = [...new Set(body.batchIds)];
  await assertBatchesExist(batchIds);

  const user: UserItem = {
    email: body.email,
    role: body.role,
    name: body.name,
    batchIds,
    active: true,
  };
  await usersDb.createUser(user); // 409 if the email already exists
  return { status: 201, body: { user } };
}

export const handler = apiHandler(handle);
