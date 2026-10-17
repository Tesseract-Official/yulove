import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  apiUrl: 'https://api.example.com/',
  cognitoDomain: 'https://auth.example.com',
  clientId: 'abc',
};

const respond = (body: BodyInit | null, status = 200) =>
  vi.fn(async () => new Response(body, { status }));

describe('loadConfig', () => {
  it('loads and validates /config.json, bypassing the cache', async () => {
    const fetchFn = respond(JSON.stringify(valid));

    const config = await loadConfig(fetchFn);

    expect(fetchFn).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
    expect(config).toEqual({ ...valid, apiUrl: 'https://api.example.com' });
  });

  it('needs only the API URL, the Cognito domain and the client id', async () => {
    const config = await loadConfig(respond(JSON.stringify(valid)));
    expect(Object.keys(config).sort()).toEqual(['apiUrl', 'clientId', 'cognitoDomain']);
  });

  it('ignores the redirect and logout URLs an older config.json still has', async () => {
    const old = {
      ...valid,
      redirectUri: 'http://localhost:5173/auth/callback',
      logoutUri: 'http://localhost:5173/',
    };

    const config = await loadConfig(respond(JSON.stringify(old)));

    expect(config).not.toHaveProperty('redirectUri');
    expect(config).not.toHaveProperty('logoutUri');
  });

  it('rejects a missing file with a message that names the fix', async () => {
    await expect(loadConfig(respond('nope', 404))).rejects.toThrow(/HTTP 404/);
  });

  it('rejects a body that is not JSON (a dev server answers with index.html)', async () => {
    await expect(loadConfig(respond('<html></html>'))).rejects.toThrow(/pnpm web:env/);
  });

  it('rejects missing or malformed fields and names them', async () => {
    // JSON leaves out undefined, so clientId is missing from the body.
    const bad = JSON.stringify({ ...valid, clientId: undefined, apiUrl: 'not a url' });

    const error = await loadConfig(respond(bad)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/apiUrl/);
    expect((error as Error).message).toMatch(/clientId/);
  });

  it('reports a network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(loadConfig(fetchFn)).rejects.toThrow(/Could not download/);
  });
});
