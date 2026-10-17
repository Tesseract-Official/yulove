import { describe, expect, it } from 'vitest';
import {
  googleErrorInfo,
  parseRetryAfter,
  parseRetryDuration,
  retryDelayOf,
} from './google-error.js';

const body = (error: object) => JSON.stringify({ error });
const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';

describe('parseRetryDuration', () => {
  it.each([
    ['34s', 34_000],
    ['0.5s', 500],
    ['1.250s', 1250],
    ['34.123456789s', 34_123],
    ['0s', 0],
    [' 7s ', 7000],
  ])('%s is %s ms', (text, ms) => {
    expect(parseRetryDuration(text)).toBe(ms);
  });

  it.each(['', 'soon', '34', '-5s', '5m', '1e3s', 'NaNs', '4000s', 5, undefined, null])(
    'ignores %j',
    (text) => {
      expect(parseRetryDuration(text)).toBeUndefined();
    },
  );
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');

  it('reads whole seconds, as a number or as text', () => {
    expect(parseRetryAfter(30, now)).toBe(30_000);
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Sat, 17 Oct 2026 10:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('Sat, 17 Oct 2026 09:00:00 GMT', now)).toBe(0);
  });

  it.each(['', 'later', -1, Number.NaN, 99_999, undefined, {}])('ignores %j', (value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

describe('googleErrorInfo', () => {
  it('reads status, message and RetryInfo from the JSON body the SDK leaves in the message', () => {
    expect(
      googleErrorInfo(
        body({
          code: 429,
          message: 'Quota exceeded for metric X',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
            { '@type': RETRY_INFO, retryDelay: '34s' },
          ],
        }),
      ),
    ).toEqual({
      googleStatus: 'RESOURCE_EXHAUSTED',
      googleMessage: 'Quota exceeded for metric X',
      retryDelayMs: 34_000,
    });
  });

  it('has no delay when there is no RetryInfo or it is unreadable', () => {
    expect(googleErrorInfo(body({ status: 'UNAVAILABLE', message: 'overloaded' }))).toEqual({
      googleStatus: 'UNAVAILABLE',
      googleMessage: 'overloaded',
    });
    expect(
      googleErrorInfo(body({ details: [{ '@type': RETRY_INFO, retryDelay: 'soon' }] })),
    ).toEqual({});
  });

  it.each([undefined, 3, '', 'upstream connect error', '[]', 'null', '{"error":"text"}'])(
    'copes with %j',
    (message) => {
      expect(googleErrorInfo(message)).toEqual({});
    },
  );
});

describe('retryDelayOf', () => {
  const rateLimited = (retryDelay: string) =>
    Object.assign(
      new Error(
        body({ status: 'RESOURCE_EXHAUSTED', details: [{ '@type': RETRY_INFO, retryDelay }] }),
      ),
      { status: 429 },
    );

  it('reads the RetryInfo in a raw SDK error', () => {
    expect(retryDelayOf(rateLimited('12s'))).toBe(12_000);
  });

  it('prefers a delay already on the error, then a retry-after, then the body', () => {
    expect(retryDelayOf(Object.assign(rateLimited('12s'), { retryDelayMs: 5000 }))).toBe(5000);
    expect(retryDelayOf(Object.assign(rateLimited('12s'), { retryAfter: '7' }))).toBe(7000);
    expect(retryDelayOf(Object.assign(new Error('x'), { headers: { 'retry-after': '9' } }))).toBe(
      9000,
    );
    expect(
      retryDelayOf(
        Object.assign(new Error('x'), { headers: new Headers({ 'retry-after': '11' }) }),
      ),
    ).toBe(11_000);
  });

  it.each([undefined, null, 'x', 5, new Error('plain'), { retryDelayMs: -1 }])(
    'has none for %j',
    (error) => {
      expect(retryDelayOf(error)).toBeUndefined();
    },
  );
});
