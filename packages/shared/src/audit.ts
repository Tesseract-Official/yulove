import { putAuditItem } from './db/audit-log.js';
import { examStudentKey } from './types.js';

const MAX_COLLISION_RETRIES = 5;

/** Audit key for an answer, e.g. a score override. */
export function answerEntityKey(
  examId: string,
  studentEmail: string,
  questionNumber: number,
): string {
  return `answer#${examStudentKey(examId, studentEmail)}#${questionNumber}`;
}

/**
 * Appends an entry to the audit log with the current time as an ISO timestamp.
 * Entries are never overwritten: if two entries for one entity land in the same millisecond,
 * the later one is written 1 ms on.
 */
export async function writeAudit(
  entityKey: string,
  actor: string,
  action: string,
  before: unknown,
  after: unknown,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  let time = now().getTime();
  for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES; attempt += 1) {
    const timestamp = new Date(time).toISOString();
    const written = await putAuditItem({
      entityKey,
      timestamp,
      actor: actor.toLowerCase(),
      action,
      before,
      after,
      reason,
    });
    if (written) return timestamp;
    time += 1;
  }
  throw new Error(`Could not write an audit entry for ${entityKey}`);
}
