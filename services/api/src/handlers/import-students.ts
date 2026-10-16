import {
  importStudentsBody,
  NotFoundError,
  parseBody,
  ConflictError,
  normaliseEmail,
  normaliseRollNo,
  type UserItem,
} from '@yulove/shared';
import { batchesDb, requireUser, usersDb, type AuthContext } from '@yulove/shared/server';
import { collegeEmailProblem, requireCollegeDomain } from '../lib/college-email.js';
import { mapLimit } from '../lib/concurrency.js';
import { FIELD_LABEL, parseStudentCsv, type StudentCsvRow } from '../lib/csv.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

const CONCURRENCY = 25;

export interface ImportedRow {
  line: number;
  email: string;
  name: string;
  rollNo: string;
  batchId: string;
}

export interface RejectedRow {
  line: number;
  email?: string;
  rollNo?: string;
  reason: string;
}

/** A row that passed the field checks, with its normalised identity (lower-case email, upper-case roll number). */
interface Candidate extends StudentCsvRow {
  emailKey: string;
  rollKey: string;
}

type Planned = { kind: 'create'; row: Candidate } | { kind: 'update'; row: Candidate };

/**
 * POST /batches/{batchId}/students/import (batch manager).
 *
 * The caller must be assigned to the URL's batch. Each row is then checked on its own; bad rows
 * are reported in `rejected` and never stop the rest from being imported.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const pathBatchId = pathParam(event, 'batchId');
  ctx.assertBatchAccess(pathBatchId);
  if (!(await batchesDb.getBatch(pathBatchId))) throw new NotFoundError(`No batch ${pathBatchId}`);

  const body = parseBody(importStudentsBody, event);
  const rows = parseStudentCsv(body.csv);
  const collegeDomain = requireCollegeDomain();

  const rejected: RejectedRow[] = [];
  const reject = (row: StudentCsvRow, reason: string) =>
    rejected.push({
      line: row.line,
      ...(row.email ? { email: row.email } : {}),
      ...(row.rollNo ? { rollNo: row.rollNo } : {}),
      reason,
    });

  // 1. Fields and email domain.
  const wellFormed: Candidate[] = [];
  for (const row of rows) {
    const missing = (['name', 'email', 'rollNo', 'batch'] as const).filter((f) => row[f] === '');
    if (missing.length > 0) {
      reject(row, `missing ${missing.map((f) => FIELD_LABEL[f]).join(', ')}`);
      continue;
    }
    const problem = collegeEmailProblem(row.email, collegeDomain);
    if (problem) {
      reject(row, problem);
      continue;
    }
    wellFormed.push({
      ...row,
      emailKey: normaliseEmail(row.email),
      rollKey: normaliseRollNo(row.rollNo),
    });
  }

  // 2. Batch exists, and the caller is assigned to it.
  const batchIds = [...new Set(wellFormed.map((r) => r.batch))];
  const existing = await mapLimit(batchIds, CONCURRENCY, (id) => batchesDb.getBatch(id));
  const batchExists = new Map(batchIds.map((id, i) => [id, existing[i] !== undefined]));

  const inAllowedBatch: Candidate[] = [];
  for (const row of wellFormed) {
    if (!batchExists.get(row.batch)) {
      reject(row, `unknown batch ${row.batch}`);
    } else if (!ctx.canAccessBatch(row.batch)) {
      reject(row, `not assigned to batch ${row.batch}`);
    } else {
      inAllowedBatch.push(row);
    }
  }

  // 3. Unique within the file (case-insensitively). The first row wins; every later row with the
  //    same email or roll number is rejected.
  const seenEmails = new Set<string>();
  const seenRolls = new Set<string>();
  const unique: Candidate[] = [];
  for (const row of inAllowedBatch) {
    if (seenEmails.has(row.emailKey)) {
      reject(row, 'Duplicate email in file');
    } else if (seenRolls.has(row.rollKey)) {
      reject(row, 'Duplicate roll number in file');
    } else {
      seenEmails.add(row.emailKey);
      seenRolls.add(row.rollKey);
      unique.push(row);
    }
  }

  // 4. Unique within the table, and existing accounts must be students the caller may manage.
  const plans = await mapLimit(unique, CONCURRENCY, (row) => plan(row, ctx));
  const planned: Planned[] = [];
  plans.forEach((result, i) => {
    const row = unique[i] as Candidate;
    if (typeof result === 'string') reject(row, result);
    else planned.push(result);
  });

  // 5. Write.
  const created: ImportedRow[] = [];
  const updated: ImportedRow[] = [];
  await mapLimit(planned, CONCURRENCY, async ({ kind, row }) => {
    const summary: ImportedRow = {
      line: row.line,
      email: row.emailKey,
      name: row.name,
      rollNo: row.rollKey,
      batchId: row.batch,
    };
    if (kind === 'create') {
      const user: UserItem = {
        email: row.emailKey,
        role: 'STUDENT',
        name: row.name,
        rollNo: row.rollKey,
        batchId: row.batch,
        active: true,
      };
      try {
        await usersDb.createUser(user);
        created.push(summary);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        reject(row, 'this email was added by someone else just now; upload again');
      }
    } else {
      const ok = await usersDb.updateUser(row.emailKey, {
        name: row.name,
        rollNo: row.rollKey,
        batchId: row.batch,
      });
      if (ok) updated.push(summary);
      else reject(row, 'the student was removed while importing; upload again');
    }
  });

  const byLine = <T extends { line: number }>(a: T, b: T) => a.line - b.line;
  created.sort(byLine);
  updated.sort(byLine);
  rejected.sort(byLine);

  return {
    status: 200,
    body: {
      created,
      updated,
      rejected,
      counts: {
        rows: rows.length,
        created: created.length,
        updated: updated.length,
        rejected: rejected.length,
      },
    },
  };
}

/** Decides whether a row creates a student, updates one, or must be rejected (a reason). */
async function plan(row: Candidate, ctx: AuthContext): Promise<Planned | string> {
  const [account, rollOwner] = await Promise.all([
    usersDb.getUser(row.emailKey),
    usersDb.getUserByRoll(row.rollKey),
  ]);

  if (rollOwner && rollOwner.email !== row.emailKey) {
    return `roll number ${row.rollKey} already belongs to ${rollOwner.email}`;
  }
  if (!account) return { kind: 'create', row };

  if (account.role !== 'STUDENT') {
    return `${row.emailKey} is a ${account.role.toLowerCase().replace('_', ' ')} account, not a student`;
  }
  if (account.batchId && !ctx.canAccessBatch(account.batchId)) {
    return `student is currently in batch ${account.batchId}, which you are not assigned to`;
  }
  return { kind: 'update', row };
}

export const handler = apiHandler(handle);
