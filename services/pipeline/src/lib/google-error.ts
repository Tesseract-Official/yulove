/** Longest delay Google may ask for that we will believe. */
const MAX_DELAY_MS = 60 * 60 * 1000;

const withinLimits = (ms: number) => Number.isFinite(ms) && ms >= 0 && ms <= MAX_DELAY_MS;

/** "34s", "0.5s", "1.250s", "34.123456789s" (the form of a protobuf Duration) in milliseconds. */
export function parseRetryDuration(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(text);
  if (!match) return undefined;
  const ms = Math.round(Number(match[1]) * 1000);
  return withinLimits(ms) ? ms : undefined;
}

/** A Retry-After value: whole seconds, or an HTTP date. In milliseconds from `now`. */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
  if (typeof value === 'number') {
    const ms = Math.round(value * 1000);
    return withinLimits(ms) ? ms : undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  if (/^\s*\d+(\.\d+)?\s*$/.test(value)) return parseRetryAfter(Number(value), now);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  // A date that has already passed means "now".
  const ms = Math.max(0, at - now);
  return withinLimits(ms) ? ms : undefined;
}

export interface GoogleErrorInfo {
  /** Google's error status, e.g. RESOURCE_EXHAUSTED. */
  googleStatus?: string;
  googleMessage?: string;
  /** The wait Google asked for (google.rpc.RetryInfo), in milliseconds. */
  retryDelayMs?: number;
}

/**
 * Reads Google's error body, which the Gemini SDK leaves as JSON text in the error message:
 * `{"error":{"code":429,"message":"…","status":"RESOURCE_EXHAUSTED","details":[{"@type":
 * "type.googleapis.com/google.rpc.RetryInfo","retryDelay":"34s"}]}}`. Anything else gives {}.
 */
export function googleErrorInfo(message: unknown): GoogleErrorInfo {
  if (typeof message !== 'string') return {};
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    return {};
  }
  const error = (body as { error?: unknown } | null)?.error as
    { status?: unknown; message?: unknown; details?: unknown } | undefined;
  if (typeof error !== 'object' || error === null) return {};

  const info: GoogleErrorInfo = {};
  if (typeof error.status === 'string') info.googleStatus = error.status;
  if (typeof error.message === 'string') info.googleMessage = error.message;
  if (Array.isArray(error.details)) {
    for (const detail of error.details as Array<Record<string, unknown>>) {
      if (String(detail?.['@type'] ?? '').endsWith('google.rpc.RetryInfo')) {
        const ms = parseRetryDuration(detail['retryDelay']);
        if (ms !== undefined) info.retryDelayMs = ms;
      }
    }
  }
  return info;
}

/**
 * How long Google asked us to wait, from an error: a `retryDelayMs` already on it, a
 * `retry-after` header or property if the SDK ever exposes one, or the RetryInfo in the body.
 */
export function retryDelayOf(error: unknown, now: number = Date.now()): number | undefined {
  const e = error as {
    retryDelayMs?: unknown;
    retryAfter?: unknown;
    headers?: unknown;
    message?: unknown;
  } | null;
  if (typeof e !== 'object' || e === null) return undefined;

  if (typeof e.retryDelayMs === 'number' && withinLimits(e.retryDelayMs)) return e.retryDelayMs;

  const headers = e.headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  const fromHeader =
    typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  const header = parseRetryAfter(e.retryAfter ?? fromHeader, now);
  if (header !== undefined) return header;

  return googleErrorInfo(e.message).retryDelayMs;
}
