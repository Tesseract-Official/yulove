import type { MeResponse } from '@yulove/shared';
import type { ApiClient } from './client.js';

/**
 * One typed function per API route, using the request and response types from @yulove/shared.
 * Screens add the routes they need here.
 */
export function createEndpoints(client: ApiClient) {
  return {
    /** GET /me: 403 means the signed-in Google account is not registered. */
    getMe: () => client.get<MeResponse>('/me'),
  };
}
export type Endpoints = ReturnType<typeof createEndpoints>;
