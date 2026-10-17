import { appendAudit } from './audit.js';
import { findCaller, type AuthEvent } from './auth.js';
import { normaliseEmail } from './identity.js';
import type { AuditLogItem, RequestOutcome } from './types.js';

/** The part of an API Gateway HTTP API event the request audit reads. */
export interface AuditableEvent extends AuthEvent {
  routeKey: string;
  rawPath: string;
  pathParameters?: Record<string, string | undefined> | undefined;
  requestContext: AuthEvent['requestContext'] & { requestId?: string | undefined };
}

/** The response fields the audit reads. */
export interface AuditableResponse {
  statusCode: number;
  body?: string | undefined;
}

const CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reads a super admin does that are logged too: every student's results and the answers. */
const LOGGED_READS = [/^GET \/exams\/[^/]+\/results$/, /^GET \/answers\//];

/** Id fields of a response body that name what the request created or changed. */
const BODY_ID_FIELDS = ['examId', 'questionId', 'batchId', 'id', 'email'] as const;

/**
 * Whether a request made by a super admin is written to the audit log: anything that changes
 * data (POST, PUT, PATCH, DELETE) and reads of results and answers.
 */
export function isAuditedRequest(routeKey: string): boolean {
  const method = routeKey.split(' ')[0] ?? '';
  return CHANGING_METHODS.has(method) || LOGGED_READS.some((pattern) => pattern.test(routeKey));
}

export function outcomeOf(statusCode: number): RequestOutcome {
  if (statusCode < 400) return 'success';
  if (statusCode === 401 || statusCode === 403) return 'denied';
  if (statusCode < 500) return 'rejected';
  return 'error';
}

/**
 * Path parameters, plus the ids named in a JSON response body, either at its top level or inside
 * one of its objects (`{ exam: { examId } }`, `{ user: { email } }`). A path parameter wins, and
 * then the shallower id.
 */
export function targetIdsOf(
  event: Pick<AuditableEvent, 'pathParameters'>,
  responseBody: string | undefined,
): Record<string, string> {
  const ids: Record<string, string> = {};
  let body: unknown;
  try {
    body = responseBody ? JSON.parse(responseBody) : undefined;
  } catch {
    body = undefined;
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (isObject(body)) {
    for (const holder of [body, ...Object.values(body).filter(isObject)]) {
      for (const field of BODY_ID_FIELDS) {
        const value = holder[field];
        if (typeof value === 'string' && value !== '' && !(field in ids)) ids[field] = value;
      }
    }
  }
  for (const [name, value] of Object.entries(event.pathParameters ?? {})) {
    if (value !== undefined) ids[name] = value;
  }
  return ids;
}

/** The audit entry for one request (without its timestamp). Never contains the request body. */
export function requestAuditEntry(
  event: AuditableEvent,
  actor: string,
  response: AuditableResponse,
  requestId: string,
): Omit<AuditLogItem, 'timestamp'> {
  return {
    entityKey: `request#${requestId}`,
    actor: normaliseEmail(actor),
    action: event.routeKey,
    before: null,
    after: null,
    reason: '',
    method: event.routeKey.split(' ')[0] ?? '',
    path: event.rawPath,
    targetIds: targetIdsOf(event, response.body),
    statusCode: response.statusCode,
    outcome: outcomeOf(response.statusCode),
  };
}

/**
 * Writes the audit entry for a request a SUPER_ADMIN made, if it is one of the audited kinds
 * (see isAuditedRequest). Requests by anyone else, or by an unknown caller, are not logged.
 *
 * It never throws and never changes the response: if the entry cannot be written, the full entry
 * is logged at error level so CloudWatch keeps the record, and the real response goes out.
 */
export async function auditSuperAdminRequest(
  event: AuditableEvent,
  response: AuditableResponse,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!isAuditedRequest(event.routeKey)) return;

  let entry: Omit<AuditLogItem, 'timestamp'> | undefined;
  try {
    const caller = await findCaller(event);
    if (caller?.role !== 'SUPER_ADMIN') return;
    entry = requestAuditEntry(
      event,
      caller.email,
      response,
      event.requestContext.requestId || crypto.randomUUID(),
    );
    await appendAudit(entry, now);
  } catch (error) {
    console.error(
      'AUDIT WRITE FAILED',
      JSON.stringify({ time: now().toISOString(), routeKey: event.routeKey, entry }),
      error,
    );
  }
}
