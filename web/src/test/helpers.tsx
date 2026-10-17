import type { MeResponse, Role } from '@yulove/shared';
import { render } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { AppProviders } from '../App.js';
import type { OidcClient } from '../auth/userManager.js';
import type { AppConfig } from '../config/config.js';
import { AppRoutes } from '../routes.js';

export const CONFIG: AppConfig = {
  apiUrl: 'https://api.example.com',
  cognitoDomain: 'https://auth.example.com',
  clientId: 'client-123',
  redirectUri: 'http://localhost:5173/auth/callback',
  logoutUri: 'http://localhost:5173/',
};

export const ID_TOKEN = 'the-id-token';
export const ACCESS_TOKEN = 'the-access-token';

export function fakeUser(userState?: unknown): User {
  return new User({
    id_token: ID_TOKEN,
    access_token: ACCESS_TOKEN,
    token_type: 'Bearer',
    profile: { sub: 'sub-1', iss: 'x', aud: 'x', exp: 0, iat: 0 },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    userState,
  });
}

type Listener<T extends unknown[]> = (...args: T) => void;

/** Stands in for oidc-client-ts's UserManager. */
export class FakeOidc implements OidcClient {
  user: User | null;
  private loaded: Listener<[User]>[] = [];
  private unloaded: Listener<[]>[] = [];
  private renewErrors: Listener<[Error]>[] = [];

  constructor(user: User | null = null) {
    this.user = user;
  }

  getUser = vi.fn(async () => this.user);
  signinRedirect = vi.fn(async () => {});
  signinRedirectCallback = vi.fn(async () => {
    if (!this.user) throw new Error('No user to return from the callback');
    for (const listener of this.loaded) listener(this.user);
    return this.user;
  });
  signinSilent = vi.fn(async () => this.user);
  removeUser = vi.fn(async () => {
    this.user = null;
    for (const listener of this.unloaded) listener();
  });

  events = {
    addUserLoaded: (cb: Listener<[User]>) => void this.loaded.push(cb),
    removeUserLoaded: (cb: Listener<[User]>) =>
      void (this.loaded = this.loaded.filter((l) => l !== cb)),
    addUserUnloaded: (cb: Listener<[]>) => void this.unloaded.push(cb),
    removeUserUnloaded: (cb: Listener<[]>) =>
      void (this.unloaded = this.unloaded.filter((l) => l !== cb)),
    addSilentRenewError: (cb: Listener<[Error]>) => void this.renewErrors.push(cb),
    removeSilentRenewError: (cb: Listener<[Error]>) =>
      void (this.renewErrors = this.renewErrors.filter((l) => l !== cb)),
  };

  failRenewal(error = new Error('refresh failed')) {
    for (const listener of this.renewErrors) listener(error);
  }
}

export function meFor(role: Role, overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    email: `${role.toLowerCase()}@college.edu`,
    name: `Test ${role}`,
    role,
    batches: [{ batchId: 'A', name: 'Batch Alpha' }],
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function apiErrorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** Replaces fetch: GET /me answers with `me()`; anything else is a 404. */
export function stubApi(me: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === `${CONFIG.apiUrl}/me`) return me();
    return apiErrorResponse(404, 'NOT_FOUND', 'Not found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

export interface RenderOptions {
  route?: string;
  oidc?: FakeOidc;
  strict?: boolean;
  navigateExternal?: (url: string) => void;
}

/** The whole app on a memory router, with a fake sign-in client. */
export function renderApp(options: RenderOptions = {}) {
  const oidc = options.oidc ?? new FakeOidc();
  const navigateExternal = options.navigateExternal ?? vi.fn();
  const tree = (
    <AppProviders config={CONFIG} authClient={oidc} navigateExternal={navigateExternal}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>
  );
  const result = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...result, oidc, navigateExternal };
}
