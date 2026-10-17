import { retryDelayOf } from './google-error.js';

/** How a failed Gemini call should be treated. */
export function isRetryable(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown; name?: unknown; cause?: unknown } | null;
  if (typeof e?.status === 'number') return e.status === 429 || e.status >= 500;

  // No HTTP status: a dropped connection or a timeout is worth another try, a bug is not.
  const names = ['AbortError', 'TimeoutError', 'FetchError'];
  const codes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'];
  const cause = e?.cause as { code?: unknown } | undefined;
  return (
    (typeof e?.name === 'string' && names.includes(e.name)) ||
    (typeof e?.code === 'string' && (codes.includes(e.code) || e.code.startsWith('UND_ERR'))) ||
    (typeof cause?.code === 'string' &&
      (codes.includes(cause.code) || cause.code.startsWith('UND_ERR'))) ||
    (e?.name === 'TypeError' && String((error as Error).message).includes('fetch failed'))
  );
}

/** Added to Google's requested wait, so the retry does not land a moment too early. */
export const RETRY_DELAY_PADDING_MS = 250;

/** What happened to one failed call, for logs and the try-transcribe script. */
export interface AttemptInfo {
  /** 1 for the first call. */
  call: number;
  error: unknown;
  /** The wait Google asked for, if it did. */
  googleDelayMs?: number;
  /** The wait before the next call; absent when there is no next call. */
  nextWaitMs?: number;
  /** True when `nextWaitMs` is Google's delay plus padding rather than our own backoff. */
  usedGoogleDelay?: boolean;
  /** Why there is no next call. */
  stopped?: 'fatal' | 'tries' | 'time';
}

export interface RetryOptions {
  /** Retries after the first try. */
  retries: number;
  /** The wait before the first retry; it doubles each time. */
  baseDelayMs: number;
  /** Milliseconds left before the Lambda is cut off. */
  remainingMs: () => number;
  /** Time one more try needs (its own timeout, plus a margin), so a retry is never started too late. */
  attemptBudgetMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1; for jitter. */
  random?: () => number;
  /** Called after every failed call. */
  onAttempt?: (info: AttemptInfo) => void;
}

export interface RetryResult<T> {
  value?: T;
  /** The last error, when every try failed or the time ran out. */
  error?: unknown;
  /** How many calls were made. */
  calls: number;
  /** True when it stopped because the error cannot be retried (as opposed to running out of tries or time). */
  fatal: boolean;
  /** True when it gave up on errors that could have been retried: Gemini is busy or unavailable. */
  busy: boolean;
  /** The wait Google asked for after the last failure, if it did. */
  googleDelayMs?: number;
}

/**
 * Calls `fn`, retrying errors that `isRetryable` accepts. After a 429 that says how long to wait
 * (google.rpc.RetryInfo), it waits that long if there is time for it; otherwise it backs off
 * exponentially with jitter. It never starts a retry that could not finish before the Lambda's
 * time runs out.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  let calls = 0;
  let lastError: unknown;
  let lastGoogleDelay: number | undefined;

  for (let retry = 0; retry <= options.retries; retry += 1) {
    calls += 1;
    try {
      return { value: await fn(), calls, fatal: false, busy: false };
    } catch (error) {
      lastError = error;
      const status = (error as { status?: unknown } | null)?.status;
      const googleDelay = status === 429 ? retryDelayOf(error) : undefined;
      lastGoogleDelay = googleDelay;
      const info: AttemptInfo = { call: calls, error };
      if (googleDelay !== undefined) info.googleDelayMs = googleDelay;

      if (!isRetryable(error)) {
        options.onAttempt?.({ ...info, stopped: 'fatal' });
        return { error, calls, fatal: true, busy: false };
      }
      if (retry === options.retries) {
        options.onAttempt?.({ ...info, stopped: 'tries' });
        break;
      }

      const wait = chooseWait(retry, googleDelay, options, random);
      if (wait === undefined) {
        options.onAttempt?.({ ...info, stopped: 'time' });
        break;
      }
      options.onAttempt?.({ ...info, nextWaitMs: wait.ms, usedGoogleDelay: wait.google });
      await sleep(wait.ms);
    }
  }
  return {
    error: lastError,
    calls,
    fatal: false,
    busy: true,
    ...(lastGoogleDelay !== undefined ? { googleDelayMs: lastGoogleDelay } : {}),
  };
}

function chooseWait(
  retry: number,
  googleDelay: number | undefined,
  options: RetryOptions,
  random: () => number,
): { ms: number; google: boolean } | undefined {
  const fits = (ms: number) => options.remainingMs() >= ms + options.attemptBudgetMs;

  if (googleDelay !== undefined) {
    const ms = googleDelay + RETRY_DELAY_PADDING_MS;
    if (fits(ms)) return { ms, google: true };
  }
  const backoff = options.baseDelayMs * 2 ** retry * (0.75 + random() * 0.5);
  return fits(backoff) ? { ms: backoff, google: false } : undefined;
}

/** Fewest and most seconds a busy message is hidden before SQS gives it to a Lambda again. */
export const MIN_REDELIVERY_SECONDS = 30;
export const MAX_REDELIVERY_SECONDS = 5 * 60;

/**
 * How long to hide a message that is going to be redelivered: what Google asked for if it did,
 * otherwise 60 s after the first busy try and 120 s after the second; never under 30 s or over
 * 5 minutes.
 */
export function redeliveryDelaySeconds(tries: number, googleDelayMs?: number): number {
  const wanted =
    googleDelayMs !== undefined ? Math.ceil(googleDelayMs / 1000) : tries <= 1 ? 60 : 120;
  return Math.min(MAX_REDELIVERY_SECONDS, Math.max(MIN_REDELIVERY_SECONDS, wanted));
}

/** Thrown so the invocation fails and the message or event is delivered again later. */
export class GeminiBusyError extends Error {
  constructor(
    message: string,
    /** The wait Google asked for, in milliseconds. */
    readonly retryDelayMs?: number,
  ) {
    super(message);
    this.name = 'GeminiBusyError';
  }
}
