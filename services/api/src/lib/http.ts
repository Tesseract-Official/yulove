import { errorResponse, ValidationError } from '@yulove/shared';
import { auditSuperAdminRequest } from '@yulove/shared/server';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

/** What a route returns on success. Failures are thrown as HttpError and mapped for you. */
export interface ApiResult {
  status: number;
  body: unknown;
}

/**
 * Wraps a route function as a Lambda handler: JSON on success, mapped HTTP errors on failure.
 *
 * Every route goes through here, so this is also where super admin activity is audited: once the
 * response is known, a SUPER_ADMIN's changes (POST, PUT, PATCH, DELETE) and reads of results and
 * answers are written to the audit log. A route cannot skip it, and it never changes the response.
 */
export function apiHandler(handle: (event: ApiEvent) => Promise<ApiResult>) {
  return async (event: ApiEvent): Promise<APIGatewayProxyResultV2 & { statusCode: number }> => {
    let response: APIGatewayProxyResultV2 & { statusCode: number };
    try {
      const { status, body } = await handle(event);
      response = {
        statusCode: status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    } catch (error) {
      response = errorResponse(error) as typeof response;
    }
    await auditSuperAdminRequest(event, response);
    return response;
  };
}

/** A required path parameter, URL-decoded. */
export function pathParam(event: ApiEvent, name: string): string {
  const raw = event.pathParameters?.[name];
  if (raw === undefined || raw === '') {
    throw new ValidationError(`Missing path parameter ${name}`);
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ValidationError(`Path parameter ${name} is not valid`);
  }
}

export function queryParam(event: ApiEvent, name: string): string | undefined {
  return event.queryStringParameters?.[name];
}
