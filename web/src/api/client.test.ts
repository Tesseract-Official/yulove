import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client.js';
import { ApiError } from './errors.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(responses: Array<Response | Error>, token: string | null = 'id-token') {
  const queue = [...responses];
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const getIdToken = vi.fn<(forceRefresh?: boolean) => Promise<string | null>>(async () => token);
  const onUnauthorized = vi.fn();
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getIdToken,
    onUnauthorized,
    fetchFn,
  });
  return { client, fetchFn, getIdToken, onUnauthorized };
}

const headersOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;

describe('createApiClient', () => {
  it('sends the ID token as a bearer token', async () => {
    const { client, fetchFn } = setup([json({ ok: true })]);

    await expect(client.get('/me')).resolves.toEqual({ ok: true });

    const call = fetchFn.mock.calls[0]!;
    expect(call[0]).toBe('https://api.example.com/me');
    expect((call[1] as RequestInit).method).toBe('GET');
    expect(headersOf(call)['authorization']).toBe('Bearer id-token');
  });

  it('sends JSON bodies with a content type', async () => {
    const { client, fetchFn } = setup([json({ id: 1 }, 201)]);

    await client.post('/batches', { batchId: 'A', name: 'Alpha' });

    const call = fetchFn.mock.calls[0]!;
    expect(headersOf(call)['content-type']).toBe('application/json');
    expect((call[1] as RequestInit).body).toBe('{"batchId":"A","name":"Alpha"}');
  });

  it('sends no content type when there is no body, and skips undefined query params', async () => {
    const { client, fetchFn } = setup([json([])]);

    await client.get('/batches/A/students', { search: 'ann lee', limit: undefined, page: 2 });

    const call = fetchFn.mock.calls[0]!;
    expect(call[0]).toBe('https://api.example.com/batches/A/students?search=ann+lee&page=2');
    expect(headersOf(call)['content-type']).toBeUndefined();
  });

  it('returns undefined for 204', async () => {
    const { client } = setup([new Response(null, { status: 204 })]);
    await expect(client.delete('/x')).resolves.toBeUndefined();
  });

  it("turns the API's error envelope into an ApiError", async () => {
    const { client } = setup([
      json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this' } }, 403),
    ]);

    const error = await client.get('/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'You do not have access to this',
    });
  });

  it("understands API Gateway's own error bodies and non-JSON failures", async () => {
    const { client } = setup([
      json({ message: 'Forbidden' }, 403),
      new Response('<html>bad gateway</html>', { status: 502 }),
    ]);

    await expect(client.get('/a')).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    await expect(client.get('/b')).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_502',
      message: 'The request failed (HTTP 502).',
    });
  });

  it('renews the token and retries once on 401', async () => {
    const { client, fetchFn, getIdToken, onUnauthorized } = setup([
      json({ message: 'Unauthorized' }, 401),
      json({ ok: 1 }),
    ]);

    await expect(client.get('/me')).resolves.toEqual({ ok: 1 });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('ends the session when the API still says 401 after a renewal', async () => {
    const { client, fetchFn, onUnauthorized } = setup([
      json({ message: 'Unauthorized' }, 401),
      json({ message: 'Unauthorized' }, 401),
    ]);

    await expect(client.get('/me')).rejects.toMatchObject({ status: 401 });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not call the API without a token', async () => {
    const { client, fetchFn, onUnauthorized } = setup([], null);

    await expect(client.get('/me')).rejects.toMatchObject({ status: 401 });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('reports an unreachable server as status 0', async () => {
    const { client } = setup([new TypeError('Failed to fetch')]);

    await expect(client.get('/me')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });
});
