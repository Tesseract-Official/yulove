import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERCEL_VARS, formatVercelEnv } from './web-vercel-env.js';

const config = {
  apiUrl: 'https://abc123.execute-api.ap-south-1.amazonaws.com',
  cognitoDomain: 'https://dsa-judge-1.auth.ap-south-1.amazoncognito.com',
  clientId: 'client-xyz',
};

describe('formatVercelEnv', () => {
  it('prints one NAME=value line for each of the three variables', () => {
    expect(formatVercelEnv(config)).toBe(
      [
        'DSA_API_URL=https://abc123.execute-api.ap-south-1.amazonaws.com',
        'DSA_COGNITO_DOMAIN=https://dsa-judge-1.auth.ap-south-1.amazoncognito.com',
        'DSA_CLIENT_ID=client-xyz',
      ].join('\n'),
    );
  });

  it('uses the variable names the web build reads', () => {
    // Pinned here and in web/scripts/write-dist-config.test.ts.
    expect(VERCEL_VARS).toEqual({
      DSA_API_URL: 'apiUrl',
      DSA_COGNITO_DOMAIN: 'cognitoDomain',
      DSA_CLIENT_ID: 'clientId',
    });
  });
});

describe('pnpm web:vercel-env', () => {
  it('refuses to run without AWS_PROFILE', () => {
    const script = fileURLToPath(new URL('./web-vercel-env.ts', import.meta.url));
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
