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
}

export interface RetryResult<T> {
  value?: T;
  /** The last error, when every try failed or the time ran out. */
  error?: unknown;
  /** How many calls were made. */
  calls: number;
  /** True when it stopped because the error cannot be retried (as opposed to running out of tries or time). */
  fatal: boolean;
}

/**
 * Calls `fn`, retrying errors that `isRetryable` accepts, with exponential backoff and jitter. It
 * never starts a retry that could not finish before the Lambda's time runs out.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  let calls = 0;
  let lastError: unknown;

  for (let retry = 0; retry <= options.retries; retry += 1) {
    if (retry > 0) {
      const delay = options.baseDelayMs * 2 ** (retry - 1) * (0.75 + random() * 0.5);
      if (options.remainingMs() < delay + options.attemptBudgetMs) break;
      await sleep(delay);
    }
    calls += 1;
    try {
      return { value: await fn(), calls, fatal: false };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) return { error, calls, fatal: true };
    }
  }
  return { error: lastError, calls, fatal: false };
}
