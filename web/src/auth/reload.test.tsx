import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG,
  FakeOidc,
  REFRESH_TOKEN,
  apiErrorResponse,
  fakeUser,
  jsonResponse,
  jwt,
  meFor,
  renderApp,
  stubApi,
} from '../test/helpers.js';
import { createUserManager } from './userManager.js';

const ENDED = 'Your session has ended. Sign in again.';
const USER_KEY = `oidc.user:${CONFIG.cognitoDomain}:${CONFIG.clientId}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What the browser does to a Bearer header, as the API sees it. */
const bearerOf = (init: RequestInit | undefined) =>
  (init?.headers as Record<string, string>)['authorization'];

const storedKeys = () => Object.keys(window.sessionStorage);

describe('reloading the page', () => {
  it('restores the session from sessionStorage, with no sign-in and no renewal', async () => {
    const fetchMock = stubApi(() => jsonResponse(meFor('STUDENT')));
    // The first page load signs in; the manager writes the user to sessionStorage.
    await createUserManager(CONFIG).storeUser(fakeUser());
    expect(window.sessionStorage.getItem(USER_KEY)).toContain('"id_token":"the-id-token"');

    // The reload: a new manager, a new app, only sessionStorage carried over.
    const reloaded = createUserManager(CONFIG);
    const redirect = vi.spyOn(reloaded, 'signinRedirect');
    const silent = vi.spyOn(reloaded, 'signinSilent');
    renderApp({ oidc: reloaded, route: '/student' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Student' })).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
    expect(silent).not.toHaveBeenCalled();
    expect(bearerOf(fetchMock.mock.calls[0]?.[1])).toBe('Bearer the-id-token');
    expect(screen.queryByText(ENDED)).not.toBeInTheDocument();
  });

  it('keeps the user in sessionStorage only: never localStorage', async () => {
    await createUserManager(CONFIG).storeUser(fakeUser());

    expect(storedKeys()).toContain(USER_KEY);
    expect(window.localStorage.length).toBe(0);
  });

  it('opens the page that was open, not the landing page', async () => {
    stubApi(() => jsonResponse(meFor('SUPER_ADMIN')));

    renderApp({ oidc: new FakeOidc(fakeUser()), route: '/teacher' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Teacher' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/teacher');
  });
});

describe('an expired token on startup', () => {
  /** A FakeOidc whose silent sign-in does what the refresh grant does: a fresh user comes back. */
  function renewing(expiredUser: ReturnType<typeof fakeUser>) {
    const oidc = new FakeOidc(expiredUser);
    oidc.signinSilent.mockImplementation(async () => {
      oidc.user = fakeUser(undefined, { idToken: 'renewed-id-token' });
      return oidc.user;
    });
    return oidc;
  }

  it.each([
    ['has expired', { idTokenExpiresIn: -30, accessTokenExpiresIn: -30 }],
    ['is about to expire', { idTokenExpiresIn: 20, accessTokenExpiresIn: 20 }],
    ['has expired while the access token has not', { idTokenExpiresIn: -5 }],
  ])('renews it, once, when the ID token %s, and carries on', async (_what, expiry) => {
    const fetchMock = stubApi(() => jsonResponse(meFor('TEACHER')));
    const oidc = renewing(fakeUser(undefined, expiry));

    renderApp({ oidc, strict: true });

    expect(await screen.findByRole('heading', { level: 1, name: 'Teacher' })).toBeInTheDocument();
    expect(oidc.signinSilent).toHaveBeenCalledTimes(1);
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
    expect(screen.queryByText(ENDED)).not.toBeInTheDocument();
    // The API is only called with the renewed token.
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(bearerOf(fetchMock.mock.calls[0]?.[1])).toBe('Bearer renewed-id-token');
  });

  it('shows the sign-in message when renewal fails, and does not call the API', async () => {
    const fetchMock = stubApi(() => jsonResponse(meFor('TEACHER')));
    const oidc = new FakeOidc(fakeUser(undefined, { idTokenExpiresIn: -30 }));
    oidc.signinSilent.mockRejectedValue(new Error('invalid_grant'));

    renderApp({ oidc, route: '/teacher' });

    expect(await screen.findByText(ENDED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(oidc.removeUser).toHaveBeenCalled();
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('shows the message, without trying, when there is no refresh token', async () => {
    stubApi(() => jsonResponse(meFor('TEACHER')));
    const oidc = new FakeOidc(fakeUser(undefined, { idTokenExpiresIn: -30, refreshToken: null }));

    renderApp({ oidc });

    expect(await screen.findByText(ENDED)).toBeInTheDocument();
    expect(oidc.signinSilent).not.toHaveBeenCalled();
    expect(oidc.removeUser).toHaveBeenCalled();
  });

  it('lets the person sign in again after the message', async () => {
    const oidc = new FakeOidc(fakeUser(undefined, { idTokenExpiresIn: -30 }));
    oidc.signinSilent.mockRejectedValue(new Error('invalid_grant'));

    renderApp({ oidc });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));

    expect(oidc.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('renews with the Cognito refresh token grant and keeps the session in sessionStorage', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = jwt({
      sub: 'sub-1',
      iss: 'https://cognito-idp.example',
      aud: CONFIG.clientId,
      iat: now,
      exp: now + 3600,
      email: 'student@college.edu',
    });
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === `${CONFIG.cognitoDomain}/oauth2/token`) {
          // Cognito does not send a new refresh token with a refresh grant.
          return jsonResponse({
            id_token: fresh,
            access_token: 'renewed-access',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (url === `${CONFIG.apiUrl}/me`) return jsonResponse(meFor('STUDENT'));
        return apiErrorResponse(404, 'NOT_FOUND', 'Not found');
      }),
    );
    // A user left in sessionStorage by an earlier page load, with expired tokens.
    // (The library compares the old and new ID token's subject, so the old one is a real JWT too.)
    const stale = jwt({
      sub: 'sub-1',
      iss: 'https://cognito-idp.example',
      exp: now - 60,
      iat: now - 3660,
    });
    await createUserManager(CONFIG).storeUser(
      fakeUser(undefined, { idToken: stale, idTokenExpiresIn: -60, accessTokenExpiresIn: -60 }),
    );
    const reloaded = createUserManager(CONFIG);

    renderApp({ oidc: reloaded });

    expect(await screen.findByRole('heading', { level: 1, name: 'Student' })).toBeInTheDocument();
    const grant = calls.find((call) => call.url.endsWith('/oauth2/token'));
    expect(grant?.init?.method).toBe('POST');
    const form = new URLSearchParams(String(grant?.init?.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(form.get('client_id')).toBe(CONFIG.clientId);
    // The API got the renewed ID token, and the renewed user replaced the old one in storage.
    expect(bearerOf(calls.find((call) => call.url.endsWith('/me'))?.init)).toBe(`Bearer ${fresh}`);
    const stored = JSON.parse(window.sessionStorage.getItem(USER_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(stored['id_token']).toBe(fresh);
    expect(stored['refresh_token']).toBe(REFRESH_TOKEN);
    expect(window.localStorage.length).toBe(0);
  });
});

describe('a token that expires while the app is open', () => {
  it('is renewed when the API says 401, and the request is retried once', async () => {
    let calls = 0;
    const fetchMock = stubApi(() => {
      calls += 1;
      return calls === 1
        ? apiErrorResponse(401, 'UNAUTHORIZED', 'expired')
        : jsonResponse(meFor('STUDENT'));
    });
    const oidc = new FakeOidc(fakeUser());
    oidc.signinSilent.mockImplementation(async () => {
      oidc.user = fakeUser(undefined, { idToken: 'renewed-id-token' });
      return oidc.user;
    });

    renderApp({ oidc });

    expect(await screen.findByRole('heading', { level: 1, name: 'Student' })).toBeInTheDocument();
    expect(oidc.signinSilent).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchMock.mock.calls[0]?.[1])).toBe('Bearer the-id-token');
    expect(bearerOf(fetchMock.mock.calls[1]?.[1])).toBe('Bearer renewed-id-token');
  });
});

describe('signing out', () => {
  it('clears sessionStorage and leaves through the Cognito logout page', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));
    const navigateExternal = vi.fn();
    const manager = createUserManager(CONFIG);
    await manager.storeUser(fakeUser());
    expect(storedKeys()).toContain(USER_KEY);

    renderApp({ oidc: createUserManager(CONFIG), navigateExternal });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(navigateExternal).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    expect(new URL(String(navigateExternal.mock.calls[0]?.[0])).pathname).toBe('/logout');
  });

  it('leaves nothing for a reload to restore', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));
    await createUserManager(CONFIG).storeUser(fakeUser());

    renderApp({ oidc: createUserManager(CONFIG), navigateExternal: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));

    expect(await createUserManager(CONFIG).getUser()).toBeNull();
  });
});
