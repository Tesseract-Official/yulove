import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFlags } from './args.js';

const options = { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' } } as const;

describe('parseFlags', () => {
  it('reads flags typed after the script name, the way pnpm passes them', () => {
    expect(parseFlags(['--dry-run'], options).values).toEqual({ 'dry-run': true });
  });

  it('still sees the flag when an extra -- came first (pnpm passes it on as a word)', () => {
    expect(parseFlags(['--', '--dry-run'], options).values).toEqual({ 'dry-run': true });
  });

  it('only drops a leading --', () => {
    expect(() => parseFlags(['--yes', '--', '--dry-run'], options)).toThrow();
  });

  it('keeps positional words when asked to', () => {
    const { values, positionals } = parseFlags(['--', 'exam-1', '--yes'], options, true);
    expect(positionals).toEqual(['exam-1']);
    expect(values).toEqual({ yes: true });
  });

  it('refuses a flag it does not know, instead of ignoring it', () => {
    expect(() => parseFlags(['--dry-runn'], options)).toThrow();
  });
});

describe('usage text in the scripts', () => {
  const scripts = readdirSync(new URL('.', import.meta.url)).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );

  it('never tells anyone to put an extra -- before a flag', () => {
    expect(scripts.length).toBeGreaterThan(5);
    for (const file of scripts) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/pnpm [\w:-]+ -- /);
    }
  });

  it('reads flags through parseFlags, not parseArgs directly', () => {
    for (const file of scripts.filter((f) => f !== 'args.ts')) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/import \{[^}]*\bparseArgs\b[^}]*\} from 'node:util'/);
    }
  });
});
