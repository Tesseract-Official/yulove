import { describe, expect, it } from 'vitest';
import { GeminiApiError } from './gemini.js';
import {
  GeminiBusyError,
  redeliveryDelaySeconds,
  RETRY_DELAY_PADDING_MS,
  isRetryable,
  withRetries,
  type AttemptInfo,
} from './retry.js';

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
      busy: false,
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

const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';
const rateLimited = (retryDelay?: string) =>
  new GeminiApiError(
    429,
    JSON.stringify({
      error: {
        message: 'Quota exceeded',
        status: 'RESOURCE_EXHAUSTED',
        ...(retryDelay ? { details: [{ '@type': RETRY_INFO, retryDelay }] } : {}),
      },
    }),
  );

describe("withRetries and Google's retry delay", () => {
  it('waits the delay Google asked for, plus a little, instead of backing off', async () => {
    const { options, waits } = setup();
    let n = 0;
    const result = await withRetries(async () => {
      n += 1;
      if (n === 1) throw rateLimited('34s');
      return 'ok';
    }, options);

    expect(result).toMatchObject({ value: 'ok', calls: 2, busy: false });
    expect(waits).toEqual([34_000 + RETRY_DELAY_PADDING_MS]);
  });

  it("uses Google's delay on each retry that has one, and backoff on the others", async () => {
    const { options, waits } = setup();
    const errors = [rateLimited('10s'), rateLimited(), rateLimited('1s')];
    await withRetries(async () => {
      const e = errors.shift();
      if (e) throw e;
      return 'ok';
    }, options);
    expect(waits).toEqual([10_250, 4000, 1250]);
  });

  it('does not use the delay when it does not fit in the time left: backs off as before', async () => {
    const { options, waits } = setup(100_000); // 70 s + a 50 s try do not fit; 2 s + 50 s do
    let n = 0;
    await withRetries(async () => {
      n += 1;
      if (n === 1) throw rateLimited('70s');
      return 'ok';
    }, options);
    expect(waits).toEqual([2000]);
  });

  it('gives up when neither fits', async () => {
    const { options, waits } = setup(40_000);
    const result = await withRetries(async () => {
      throw rateLimited('70s');
    }, options);
    expect(waits).toEqual([]);
    expect(result).toMatchObject({ calls: 1, busy: true, fatal: false, googleDelayMs: 70_000 });
  });

  it('only trusts a delay on a 429', async () => {
    const { options, waits } = setup();
    const unavailable = new GeminiApiError(
      503,
      JSON.stringify({
        error: { status: 'UNAVAILABLE', details: [{ '@type': RETRY_INFO, retryDelay: '20s' }] },
      }),
    );
    let n = 0;
    await withRetries(async () => {
      n += 1;
      if (n === 1) throw unavailable;
      return 'ok';
    }, options);
    expect(waits).toEqual([2000]);
  });

  it('never makes more than 3 retries, however long Google asks to wait', async () => {
    const { options } = setup();
    let n = 0;
    const result = await withRetries(async () => {
      n += 1;
      throw rateLimited('5s');
    }, options);
    expect(n).toBe(4);
    expect(result).toMatchObject({ calls: 4, busy: true });
  });
});

describe('withRetries reports every failed call', () => {
  it('tells onAttempt what happened and what comes next', async () => {
    const { options } = setup();
    const seen: AttemptInfo[] = [];
    await withRetries(
      async () => {
        throw rateLimited('3s');
      },
      { ...options, retries: 2, onAttempt: (info) => seen.push(info) },
    );

    expect(seen.map((a) => [a.call, a.nextWaitMs, a.usedGoogleDelay, a.stopped])).toEqual([
      [1, 3250, true, undefined],
      [2, 3250, true, undefined],
      [3, undefined, undefined, 'tries'],
    ]);
    expect(seen[0]?.googleDelayMs).toBe(3000);
  });

  it('says why it stopped: fatal, tries or time', async () => {
    const { options } = setup();
    const stops: Array<AttemptInfo['stopped']> = [];
    const note = (info: AttemptInfo) => void stops.push(info.stopped);

    await withRetries(
      async () => {
        throw Object.assign(new Error('bad'), { status: 400 });
      },
      { ...options, onAttempt: note },
    );
    await withRetries(
      async () => {
        throw rateLimited();
      },
      { ...options, remainingMs: () => 10_000, onAttempt: note },
    );

    expect(stops).toEqual(['fatal', 'time']);
  });
});

describe('withRetries results', () => {
  it('is busy when retryable errors outlast the tries, not when the error is fatal', async () => {
    const { options } = setup();
    expect(
      await withRetries(async () => {
        throw rateLimited();
      }, options),
    ).toMatchObject({ busy: true, fatal: false });
    expect(
      await withRetries(async () => {
        throw Object.assign(new Error('bad'), { status: 403 });
      }, options),
    ).toMatchObject({ busy: false, fatal: true });
    expect(await withRetries(async () => 1, options)).toMatchObject({ busy: false });
  });
});

describe('redeliveryDelaySeconds', () => {
  it.each([
    [1, undefined, 60],
    [2, undefined, 120],
    [1, 90_000, 90],
    [1, 90_001, 91],
    [2, 10_000, 30],
    [1, 0, 30],
    [1, 1_200_000, 300],
  ])('try %s, Google asked %s ms -> %s s', (tries, asked, expected) => {
    expect(redeliveryDelaySeconds(tries, asked)).toBe(expected);
  });
});

describe('GeminiBusyError', () => {
  it('carries the delay Google asked for', () => {
    const error = new GeminiBusyError('busy', 5000);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryDelayMs).toBe(5000);
    expect(error.name).toBe('GeminiBusyError');
  });
});
