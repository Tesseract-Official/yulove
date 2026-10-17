import type { Role, UserItem } from '@yulove/shared';
import type { ApiEvent } from '../lib/http.js';

interface EventOptions {
  method: string;
  path: string;
  /** The route as API Gateway names it, e.g. 'GET /exams/{id}/results'. Default: method and path. */
  routeKey?: string;
  /** Default: a new id for every event. */
  requestId?: string;
  /** Email in the JWT. Omit for an unauthenticated request. */
  email?: string | undefined;
  pathParameters?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

/** A minimal API Gateway HTTP API event with JWT authorizer claims. */
let requests = 0;

export function makeEvent({
  method,
  path,
  routeKey,
  requestId,
  email,
  pathParameters,
  query,
  body,
}: EventOptions): ApiEvent {
  return {
    version: '2.0',
    routeKey: routeKey ?? `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    queryStringParameters: query,
    pathParameters,
    isBase64Encoded: false,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: {
      requestId: requestId ?? `req-${(requests += 1)}`,
      http: { method, path },
      authorizer: { jwt: { claims: email ? { email } : {}, scopes: [] } },
    },
  } as unknown as ApiEvent;
}

/** A user of the given role. Staff get `batchIds`, students get `batchId`. */
export function userOf(role: Role, extra: Partial<UserItem> & { email?: string } = {}): UserItem {
  const email = extra.email ?? `${role.toLowerCase().replace('_', '-')}@college.edu`;
  return { email, role, name: `${role} user`, active: true, ...extra };
}

/** Roles (other than the all-powerful SUPER_ADMIN) that must be refused when only `allowed` may call. */
export const deniedRoles = (...allowed: Role[]): Role[] =>
  (['TEACHER', 'BATCH_MANAGER', 'STUDENT'] as const).filter((r) => !allowed.includes(r));

type Invokable = (event: ApiEvent) => Promise<unknown>;

/** Runs a handler the way API Gateway would and returns the status and parsed JSON body. */
export async function invoke(
  handler: Invokable,
  event: ApiEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into arbitrary JSON
): Promise<{ status: number; body: any }> {
  const response = (await handler(event)) as { statusCode: number; body?: string };
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}
