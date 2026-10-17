import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/errors.js';
import { useAuth } from '../auth/AuthContext.js';
import { shouldRetry } from '../query/queryClient.js';

/** GET /me for the signed-in user. The screen shows its failures itself, so there is no toast. */
export function useMe() {
  const { status, userId } = useAuth();
  const api = useApi();
  return useQuery({
    queryKey: ['me', userId],
    queryFn: () => api.getMe(),
    enabled: status === 'signedIn',
    meta: { errorToast: false },
    retry: shouldRetry,
  });
}

/** 403 from GET /me: the Google account signed in but is not in the Users table. */
export function isNotRegistered(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}
