import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  errorResponse,
  parseBody,
} from './errors.js';

afterEach(() => vi.restoreAllMocks());

describe('errorResponse', () => {
  it.each([
    [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new ValidationError(), 422, 'VALIDATION_FAILED'],
  ])('maps %o to %i', (error, statusCode, code) => {
    const response = errorResponse(error) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(statusCode);
    expect(JSON.parse(response.body).error.code).toBe(code);
  });

  it('includes validation details', () => {
    const response = errorResponse(new ValidationError('bad', { field: 'x' })) as { body: string };
    expect(JSON.parse(response.body).error.details).toEqual({ field: 'x' });
  });

  it('hides the cause of an unknown error behind a 500', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = errorResponse(new Error('secret table name leaked')) as {
      statusCode: number;
      body: string;
    };
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
  });
});

describe('parseBody', () => {
  const schema = z.object({ n: z.number() });

  it('parses a JSON body', () => {
    expect(parseBody(schema, { body: '{"n":1}' })).toEqual({ n: 1 });
  });

  it('decodes a base64 body, including non-ASCII text', () => {
    const body = Buffer.from(JSON.stringify({ n: 1, note: 'é' })).toString('base64');
    expect(
      parseBody(z.object({ n: z.number(), note: z.string() }), { body, isBase64Encoded: true }),
    ).toEqual({
      n: 1,
      note: 'é',
    });
  });

  it.each([
    ['a missing body', { body: undefined }],
    ['an empty body', { body: '' }],
    ['invalid JSON', { body: '{nope' }],
    ['a body that fails the schema', { body: '{"n":"one"}' }],
  ])('throws a 422 for %s', (_label, event) => {
    const attempt = () => parseBody(schema, event);
    expect(attempt).toThrow(ValidationError);
    try {
      attempt();
    } catch (error) {
      expect((error as ValidationError).statusCode).toBe(422);
    }
  });
});
