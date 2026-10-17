import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../api/errors.js';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { errorToast?: boolean };
    mutationMeta: { errorToast?: boolean };
  }
}

/** Retry network and server errors a couple of times; a 4xx will not change by asking again. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.isClientError) return false;
  return failureCount < 2;
}

/**
 * Every failed query or mutation raises a toast unless its `meta.errorToast` is false (used when the
 * screen shows the failure itself).
 */
export function createQueryClient(notify: (message: string) => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.errorToast !== false) notify(errorMessage(error));
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.errorToast !== false) notify(errorMessage(error));
      },
    }),
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000, refetchOnWindowFocus: false },
    },
  });
}
