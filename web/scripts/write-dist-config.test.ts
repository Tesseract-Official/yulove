// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_VARS, configFromEnv, writeDistConfig } from './write-dist-config.js';

const ALL = {
  DSA_API_URL: 'https://abc.execute-api.ap-south-1.amazonaws.com/',
  DSA_COGNITO_DOMAIN: 'https://dsa-judge-1.auth.ap-south-1.amazoncognito.com',
  DSA_CLIENT_ID: 'client-xyz',
};

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Runs the real script the way the Vercel build does, with only the given variables. */
function runScript(env: Record<string, string>) {
  const dist = join(mkdtempSync(join(tmpdir(), 'web-dist-')), 'dist');
  const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/write-dist-config.ts'], {
    cwd: WEB_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      ...env,
      DSA_DIST_DIR: dist,
    },
    encoding: 'utf8',
  });
  return { ...result, file: join(dist, 'config.json') };
}

describe('environment variable names', () => {
  it('are the three Vercel variables, one per config key', () => {
    expect(ENV_VARS).toEqual({
      DSA_API_URL: 'apiUrl',
      DSA_COGNITO_DOMAIN: 'cognitoDomain',
      DSA_CLIENT_ID: 'clientId',
    });
  });
});

describe('configFromEnv', () => {
  it('builds exactly the three config keys, without a trailing slash on URLs', () => {
    expect(configFromEnv(ALL)).toEqual({
      apiUrl: 'https://abc.execute-api.ap-south-1.amazonaws.com',
      cognitoDomain: 'https://dsa-judge-1.auth.ap-south-1.amazoncognito.com',
      clientId: 'client-xyz',
    });
  });

  it.each(Object.keys(ALL))('fails when %s is missing, naming it', (name) => {
    const env: Record<string, string> = { ...ALL };
    delete env[name];

    expect(() => configFromEnv(env)).toThrow(new RegExp(`variable: ${name}\\.`));
  });

  it('treats a blank value as missing', () => {
    expect(() => configFromEnv({ ...ALL, DSA_CLIENT_ID: '  ' })).toThrow(/DSA_CLIENT_ID/);
  });

  it('names every missing variable at once and says where to set them', () => {
    const error = (() => {
      try {
        configFromEnv({});
      } catch (e) {
        return e as Error;
      }
    })();

    for (const name of Object.keys(ALL)) expect(error?.message).toContain(name);
    expect(error?.message).toContain('Vercel');
    expect(error?.message).toContain('pnpm web:vercel-env');
  });

  it('rejects a value that is not a URL, naming the variable', () => {
    expect(() => configFromEnv({ ...ALL, DSA_API_URL: 'not a url' })).toThrow(/DSA_API_URL/);
  });
});

describe('writeDistConfig', () => {
  it('writes dist/config.json', () => {
    const dist = join(mkdtempSync(join(tmpdir(), 'web-dist-')), 'dist');

    const file = writeDistConfig(configFromEnv(ALL), dist);

    expect(file).toBe(join(dist, 'config.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(configFromEnv(ALL));
  });
});

describe('the build step (tsx scripts/write-dist-config.ts)', () => {
  it('fails the build with a clear message when the variables are missing', () => {
    const result = runScript({});

    expect(result.status).toBe(1);
    expect(result.stderr.split('\n')[0]).toBe(
      'Missing environment variables: DSA_API_URL, DSA_COGNITO_DOMAIN, DSA_CLIENT_ID.',
    );
    expect(result.stderr).toContain('Vercel');
    expect(existsSync(result.file)).toBe(false);
  });

  it('fails when only some variables are set', () => {
    const result = runScript({ DSA_API_URL: ALL.DSA_API_URL });

    expect(result.status).toBe(1);
    // The first line lists what is missing, and DSA_API_URL is set.
    expect(result.stderr.split('\n')[0]).toBe(
      'Missing environment variables: DSA_COGNITO_DOMAIN, DSA_CLIENT_ID.',
    );
  });

  it('writes config.json with exactly the three keys when all are set', () => {
    const result = runScript(ALL);

    expect(result.status).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(result.file, 'utf8'))).sort()).toEqual([
      'apiUrl',
      'clientId',
      'cognitoDomain',
    ]);
  });
});
