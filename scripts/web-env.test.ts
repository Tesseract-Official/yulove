import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_STACK, DEV_ORIGIN, buildWebConfig, writeWebConfig } from './web-env.js';

const auth = {
  UserPoolId: 'ap-south-1_abc',
  UserPoolClientId: 'client-xyz',
  HostedUiBaseUrl: 'https://dsa-judge-1.auth.ap-south-1.amazoncognito.com',
};
const api = { ApiUrl: 'https://abc123.execute-api.ap-south-1.amazonaws.com' };

describe('buildWebConfig', () => {
  it('uses the deployed outputs and the local dev origin', () => {
    expect(buildWebConfig(auth, api)).toEqual({
      apiUrl: 'https://abc123.execute-api.ap-south-1.amazonaws.com',
      cognitoDomain: 'https://dsa-judge-1.auth.ap-south-1.amazoncognito.com',
      clientId: 'client-xyz',
      redirectUri: 'http://localhost:5173/auth/callback',
      logoutUri: 'http://localhost:5173/',
    });
    expect(DEV_ORIGIN).toBe('http://localhost:5173');
  });

  it('drops trailing slashes', () => {
    const config = buildWebConfig(
      { ...auth, HostedUiBaseUrl: `${auth.HostedUiBaseUrl}/` },
      { ApiUrl: `${api.ApiUrl}/` },
    );
    expect(config.apiUrl).toBe(api.ApiUrl);
    expect(config.cognitoDomain).toBe(auth.HostedUiBaseUrl);
  });

  it.each([
    ['the client id', { ...auth, UserPoolClientId: '' }, api, /UserPoolClientId/],
    ['the hosted UI URL', { UserPoolClientId: 'c' }, api, /HostedUiBaseUrl/],
    ['the API URL', auth, {}, new RegExp(`ApiUrl.*${API_STACK}|${API_STACK}.*ApiUrl`)],
  ])('names a stack output that is missing: %s', (_what, authOut, apiOut, pattern) => {
    expect(() => buildWebConfig(authOut, apiOut)).toThrow(pattern);
  });
});

describe('writeWebConfig', () => {
  it('writes readable JSON, creating the folder', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'web-env-')), 'public', 'config.json');
    const config = buildWebConfig(auth, api);

    writeWebConfig(config, file);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config);
  });
});

describe('pnpm web:env', () => {
  it('refuses to run without AWS_PROFILE', () => {
    const script = fileURLToPath(new URL('./web-env.ts', import.meta.url));
    const env = { ...process.env };
    delete env['AWS_PROFILE'];

    const result = spawnSync('pnpm', ['exec', 'tsx', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Set AWS_PROFILE');
  });
});
