import type { StaffListResponse, StaffMember } from '@yulove/shared';
import { requireUser, usersDb } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** GET /staff (super admin): every teacher and batch manager, by name, with their batches. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  await requireUser(event, []);

  const staff: StaffMember[] = (await usersDb.listStaff())
    .flatMap((user) =>
      user.role === 'TEACHER' || user.role === 'BATCH_MANAGER'
        ? [
            {
              email: user.email,
              name: user.name,
              role: user.role,
              batchIds: user.batchIds ?? [],
              active: user.active !== false,
            },
          ]
        : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));

  const body: StaffListResponse = { staff };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
