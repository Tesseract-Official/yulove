import type { ApiErrorBody } from '@yulove/shared';
import { ApiError } from './errors.js';

export interface ApiClientOptions {
  /** The API base URL without a trailing slash. */
  baseUrl: string;
  /**
   * The Cognito ID token (the API needs its email claim). With `forceRefresh` the token is renewed
   * first. Null means nobody is signed in.
   */
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
  /** Called when the API still says 401 after one refresh: the session is over. */
  onUnauthorized: () => void;
  fetchFn?: typeof fetch;
}

export type QueryParams = Record<string, string | number | undefined>;

export interface ApiClient {
  get<T>(path: string, params?: QueryParams): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/** Reads the API's error envelope; API Gateway's own `{ message }` bodies are understood too. */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isErrorBody(body)) {
    return new ApiError(response.status, body.error.code, body.error.message, body.error.details);
  }
  const message =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : `The request failed (HTTP ${response.status}).`;
  return new ApiError(response.status, `HTTP_${response.status}`, message);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const send = async (
    method: string,
    path: string,
    body: unknown,
    forceRefresh: boolean,
  ): Promise<Response> => {
    const token = await options.getIdToken(forceRefresh);
    if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'You are signed out. Sign in again.');

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    try {
      return await fetchFn(`${options.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
      );
    }
  };

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await send(method, path, body, false);
      // The ID token may have just expired: renew it and try once more.
      if (response.status === 401) response = await send(method, path, body, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) options.onUnauthorized();
      throw error;
    }

    if (response.status === 401) {
      options.onUnauthorized();
      throw await toApiError(response);
    }
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  return {
    get: (path, params) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined) query.set(key, String(value));
      }
      const text = query.toString();
      return request('GET', text ? `${path}?${text}` : path);
    },
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    delete: (path) => request('DELETE', path),
  };
}
