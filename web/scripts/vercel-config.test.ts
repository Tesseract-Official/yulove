// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as Record<
    string,
    unknown
  >;

const vercel = read('../vercel.json') as {
  framework: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const pkg = read('../package.json') as { scripts: Record<string, string> };

describe('vercel.json', () => {
  it('rewrites every path to index.html (single-page app)', () => {
    expect(vercel.rewrites).toContainEqual({ source: '/(.*)', destination: '/index.html' });
  });

  it('is a Vite app that builds with the script that writes config.json', () => {
    expect(vercel.framework).toBe('vite');
    expect(vercel.outputDirectory).toBe('dist');
    expect(vercel.buildCommand).toBe('pnpm run build:vercel');
    expect(pkg.scripts['build:vercel']).toContain('write-dist-config');
  });

  it('keeps the plain build free of the environment variables', () => {
    expect(pkg.scripts['build']).not.toContain('write-dist-config');
  });

  it('installs from the workspace root so @yulove/shared and the lockfile are found', () => {
    expect(vercel.installCommand).toMatch(/^cd \.\. && pnpm install --frozen-lockfile /);
    expect(vercel.installCommand).toContain('--filter @yulove/web...');
  });

  it('never caches config.json', () => {
    const rule = vercel.headers.find((h) => h.source === '/config.json');
    expect(rule?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' });
  });

  it('sends basic security headers on every path', () => {
    const rule = vercel.headers.find((h) => h.source === '/(.*)');
    const keys = rule?.headers.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining(['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']),
    );
  });
});
