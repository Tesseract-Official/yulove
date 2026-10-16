import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ZodType } from 'zod';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401: no usable identity on the request. */
export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

/** 403: known caller, not allowed to do this. */
export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have access to this') {
    super(403, 'FORBIDDEN', message);
  }
}

/** 404: the thing asked for does not exist. */
export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

/** 409: the request conflicts with current state (duplicate, stale attempt). */
export class ConflictError extends HttpError {
  constructor(message = 'Conflict with the current state') {
    super(409, 'CONFLICT', message);
  }
}

/** 422: the body or parameters failed validation. */
export class ValidationError extends HttpError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

/** Turns any thrown value into an API Gateway response. Unknown errors become a bare 500. */
export function errorResponse(error: unknown): APIGatewayProxyResultV2 {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      }),
    };
  }

  console.error('Unhandled error', error);
  return {
    statusCode: 500,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }),
  };
}

export interface BodyEvent {
  body?: string | undefined;
  isBase64Encoded?: boolean | undefined;
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Parses the JSON body and validates it. Throws ValidationError (422) on any problem. */
export function parseBody<T>(schema: ZodType<T>, event: BodyEvent): T {
  if (event.body === undefined || event.body === '') {
    throw new ValidationError('Request body is required');
  }

  let json: unknown;
  try {
    const text = event.isBase64Encoded ? decodeBase64(event.body) : event.body;
    json = JSON.parse(text);
  } catch {
    throw new ValidationError('Request body is not valid JSON');
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ValidationError('Request body failed validation', z.treeifyError(result.error));
  }
  return result.data;
}
