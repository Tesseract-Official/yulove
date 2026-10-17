import { describe, expect, it } from 'vitest';
import { isRetryable, withRetries } from './retry.js';

const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('isRetryable', () => {
  it.each([429, 500, 502, 503, 504])('retries HTTP %s', (status) => {
    expect(isRetryable(apiError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %s', (status) => {
    expect(isRetryable(apiError(status))).toBe(false);
  });

  it('retries a dropped connection or a timeout', () => {
    expect(isRetryable(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('does not retry a plain bug', () => {
    expect(isRetryable(new Error('Gemini returned no text'))).toBe(false);
    expect(isRetryable(new TypeError('x is undefined'))).toBe(false);
    expect(isRetryable('nope')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

function setup(remaining = 1_000_000) {
  const waits: number[] = [];
  return {
    waits,
    options: {
      retries: 3,
      baseDelayMs: 2000,
      attemptBudgetMs: 50_000,
      remainingMs: () => remaining,
      sleep: async (ms: number) => void waits.push(ms),
      random: () => 0.5, // jitter factor 1
    },
  };
}

describe('withRetries', () => {
  it('returns the first success without waiting', async () => {
    const { options, waits } = setup();
    expect(await withRetries(async () => 'ok', options)).toEqual({
      value: 'ok',
      calls: 1,
      fatal: false,
    });
    expect(waits).toEqual([]);
  });

  it('backs off 2 s, 4 s, 8 s and then succeeds', async () => {
    const { options, waits } = setup();
    let n = 0;
    const result = await withRetries(async () => {
      n += 1;
      if (n < 4) throw apiError(429);
      return 'ok';
    }, options);

    expect(result).toMatchObject({ value: 'ok', calls: 4 });
    expect(waits).toEqual([2000, 4000, 8000]);
  });

  it('gives up after 3 retries (4 calls) and returns the last error', async () => {
    const { options } = setup();
    let n = 0;
    const result = await withRetries(async () => {
      n += 1;
      throw apiError(503);
    }, options);

    expect(n).toBe(4);
    expect(result).toMatchObject({ calls: 4, fatal: false });
    expect(result.value).toBeUndefined();
    expect((result.error as { status: number }).status).toBe(503);
  });

  it('stops at once on an error that cannot be retried', async () => {
    const { options, waits } = setup();
    const result = await withRetries(async () => {
      throw apiError(400);
    }, options);

    expect(result).toMatchObject({ calls: 1, fatal: true });
    expect(waits).toEqual([]);
  });

  it('does not start a retry that could not finish before the Lambda is cut off', async () => {
    const { options, waits } = setup(51_000); // a 2 s wait + a 50 s try do not fit
    let n = 0;
    const result = await withRetries(async () => {
      n += 1;
      throw apiError(429);
    }, options);

    expect(n).toBe(1);
    expect(waits).toEqual([]);
    expect(result).toMatchObject({ calls: 1, fatal: false });
  });

  it('adds jitter to the waits', async () => {
    const { options, waits } = setup();
    await withRetries(
      async () => {
        throw apiError(429);
      },
      { ...options, random: () => 0 },
    );
    expect(waits).toEqual([1500, 3000, 6000]);
  });
});
