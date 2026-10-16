import { errorResponse, ValidationError } from '@yulove/shared';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

/** What a route returns on success. Failures are thrown as HttpError and mapped for you. */
export interface ApiResult {
  status: number;
  body: unknown;
}

/** Wraps a route function as a Lambda handler: JSON on success, mapped HTTP errors on failure. */
export function apiHandler(handle: (event: ApiEvent) => Promise<ApiResult>) {
  return async (event: ApiEvent): Promise<APIGatewayProxyResultV2> => {
    try {
      const { status, body } = await handle(event);
      return {
        statusCode: status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    } catch (error) {
      return errorResponse(error);
    }
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
