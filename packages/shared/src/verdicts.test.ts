import { describe, expect, it } from 'vitest';
import type { TestVerdict } from './types.js';
import { countPassed, storedVerdicts, VERDICT_TEXT_LIMIT } from './verdicts.js';

const long = 'x'.repeat(500);

describe('storedVerdicts', () => {
  it('keeps input, expected and actual for a failed small test, cut to 200 characters', () => {
    const [kept] = storedVerdicts([
      { index: 2, kind: 'small', verdict: 'WA', input: long, expected: '6', actual: long },
    ]);

    expect(kept).toEqual({
      index: 2,
      kind: 'small',
      verdict: 'WA',
      input: `${'x'.repeat(197)}...`,
      expected: '6',
      actual: `${'x'.repeat(197)}...`,
    });
    expect(kept?.input).toHaveLength(VERDICT_TEXT_LIMIT);
  });

  it('keeps nothing extra for passed small tests or for any large test', () => {
    const out = storedVerdicts([
      { index: 0, kind: 'small', verdict: 'AC', input: 'a', expected: 'b', actual: 'b' },
      { index: 7, kind: 'large', verdict: 'TLE', input: long, expected: long, actual: long },
    ]);
    expect(out).toEqual([
      { index: 0, kind: 'small', verdict: 'AC' },
      { index: 7, kind: 'large', verdict: 'TLE' },
    ]);
  });

  it('copes with a failed small test that has no detail, and does not change its input', () => {
    const input: TestVerdict[] = [{ index: 1, kind: 'small', verdict: 'CE' }];
    expect(storedVerdicts(input)).toEqual([{ index: 1, kind: 'small', verdict: 'CE' }]);
    expect(input[0]).toEqual({ index: 1, kind: 'small', verdict: 'CE' });
  });

  it('leaves text of exactly 200 characters alone', () => {
    const text = 'y'.repeat(200);
    const [kept] = storedVerdicts([{ index: 0, kind: 'small', verdict: 'WA', input: text }]);
    expect(kept?.input).toBe(text);
  });
});

describe('countPassed', () => {
  it('counts AC only', () => {
    expect(
      countPassed([{ verdict: 'AC' }, { verdict: 'WA' }, { verdict: 'AC' }, { verdict: 'CE' }]),
    ).toBe(2);
    expect(countPassed([])).toBe(0);
  });
});
