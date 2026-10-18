import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cdkJson = JSON.parse(readFileSync(join(root, 'infra/cdk.json'), 'utf8')) as {
  context: Record<string, unknown>;
};

/** Source files (not tests) where a model name could be hard-coded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (['node_modules', 'dist', 'cdk.out', 'coverage'].includes(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('the Gemini model', () => {
  it('is set in infra/cdk.json for both jobs, as a real model name', () => {
    for (const key of ['geminiTestgenModel', 'geminiTranscribeModel']) {
      expect(cdkJson.context[key], key).toMatch(/^gemini-[a-z0-9.-]+$/);
    }
  });

  it('is written nowhere else: switching models means changing only infra/cdk.json', () => {
    const dirs = ['services', 'packages', 'worker', 'scripts', 'infra', 'web'].map((d) =>
      join(root, d),
    );
    const offenders = dirs
      .flatMap((dir) => sourceFiles(dir))
      .filter((file) => /['"`]gemini-\d/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.replace(root, ''))).toEqual([]);
  });
});
