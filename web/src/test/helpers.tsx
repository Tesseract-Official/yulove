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
};

export const ID_TOKEN = 'the-id-token';
export const ACCESS_TOKEN = 'the-access-token';

export const REFRESH_TOKEN = 'the-refresh-token';

/** An unsigned JWT: oidc-client-ts reads the claims but does not check the signature. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

export interface FakeUserOptions {
  /** Passed back as `user.state` (where the page to return to is kept). */
  userState?: unknown;
  idToken?: string;
  /** Seconds until the ID token expires (negative: already expired). Default one hour. */
  idTokenExpiresIn?: number;
  /** Seconds until the access token expires. Default one hour. */
  accessTokenExpiresIn?: number;
  /** Null for a user that has no refresh token. */
  refreshToken?: string | null;
}

/** A signed-in user as oidc-client-ts holds it. */
export function fakeUser(userState?: unknown, options: FakeUserOptions = {}): User {
  const now = Math.floor(Date.now() / 1000);
  const refreshToken = options.refreshToken === undefined ? REFRESH_TOKEN : options.refreshToken;
  return new User({
    id_token: options.idToken ?? ID_TOKEN,
    access_token: ACCESS_TOKEN,
    token_type: 'Bearer',
    ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    profile: {
      sub: 'sub-1',
      iss: 'x',
      aud: 'x',
      iat: now,
      exp: now + (options.idTokenExpiresIn ?? 3600),
    },
    expires_at: now + (options.accessTokenExpiresIn ?? 3600),
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
    // The student home asks for the published exams; these tests have none.
    if (url === `${CONFIG.apiUrl}/me/exams`) return jsonResponse({ exams: [] });
    return apiErrorResponse(404, 'NOT_FOUND', 'Not found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

export interface RenderOptions<T extends OidcClient = FakeOidc> {
  route?: string;
  oidc?: T;
  strict?: boolean;
  navigateExternal?: (url: string) => void;
}

/** The whole app on a memory router, with a fake sign-in client. */
export function renderApp<T extends OidcClient = FakeOidc>(options: RenderOptions<T> = {}) {
  const oidc = (options.oidc ?? new FakeOidc()) as T;
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
