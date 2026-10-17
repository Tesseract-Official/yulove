import { vi } from 'vitest';
import { CONFIG, apiErrorResponse, jsonResponse } from './helpers.js';

export interface ApiCall {
  method: string;
  /** The path with the API's address removed, e.g. `/exams/exam-1/answers`. */
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = Response | object | undefined;
export type Route = Reply | ((call: ApiCall) => Reply | Promise<Reply>);

export interface S3Post {
  url: string;
  /** Every form entry in the order it was sent; the file is `File` or `Blob`. */
  entries: Array<[string, FormDataEntryValue]>;
  headers: Record<string, string>;
}

/** An error reply in the API's own format. */
export const apiError = (status: number, code: string, message: string, details?: unknown) =>
  jsonResponse({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

function toRegExp(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, name) => {
    names.push(name as string);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}$`), names };
}

/**
 * Replaces fetch with a small fake API. `routes` maps `'METHOD /path/:param'` to a reply: a
 * Response, a JSON value (status 200) or a function of the call. Requests to the API's address are
 * matched against it (no match: a 404 in the API's error format); anything else is treated as the
 * S3 upload and answered with `s3` (default 204, as S3 does).
 */
export function mockApi(
  routes: Record<string, Route>,
  options: { s3?: (post: S3Post) => Response } = {},
) {
  const compiled = Object.entries(routes).map(([key, reply]) => {
    const [method = '', ...rest] = key.split(' ');
    return { method, reply, ...toRegExp(rest.join(' ')) };
  });
  const calls: ApiCall[] = [];
  const s3Posts: S3Post[] = [];

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );

    if (!String(input).startsWith(CONFIG.apiUrl)) {
      const form = init?.body as FormData;
      const post: S3Post = { url: String(input), entries: [...form.entries()], headers };
      s3Posts.push(post);
      return options.s3 ? options.s3(post) : new Response(null, { status: 204 });
    }

    const method = init?.method ?? 'GET';
    const path = url.pathname;
    for (const route of compiled) {
      const match = route.method === method ? route.regex.exec(path) : null;
      if (!match) continue;
      const params = Object.fromEntries(
        route.names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? '')]),
      );
      const call: ApiCall = {
        method,
        path,
        query: url.searchParams,
        params,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers,
      };
      calls.push(call);
      const reply = typeof route.reply === 'function' ? await route.reply(call) : route.reply;
      if (reply instanceof Response) return reply;
      return jsonResponse(reply ?? {});
    }
    calls.push({ method, path, query: url.searchParams, params: {}, body: undefined, headers });
    return apiErrorResponse(404, 'NOT_FOUND', 'Not found');
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    calls,
    s3Posts,
    /** The calls made to routes like `'POST /answers/submit'`. */
    callsTo: (key: string) => {
      const [method, ...rest] = key.split(' ');
      const { regex } = toRegExp(rest.join(' '));
      return calls.filter((c) => c.method === method && regex.test(c.path));
    },
  };
}
