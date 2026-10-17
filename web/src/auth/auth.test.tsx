import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OidcClient as ProtocolClient } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG,
  FakeOidc,
  fakeUser,
  jsonResponse,
  jwt,
  meFor,
  renderApp,
  stubApi,
} from '../test/helpers.js';
import {
  appUrls,
  buildLogoutUrl,
  createUserManager,
  describeSignInError,
  safeReturnPath,
} from './userManager.js';

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('the sign-in callback', () => {
  it('exchanges the code once, even under StrictMode, and opens the saved page', async () => {
    stubApi(() => jsonResponse(meFor('TEACHER')));
    const oidc = new FakeOidc(fakeUser({ returnTo: '/teacher' }));

    renderApp({ route: '/auth/callback?code=abc&state=xyz', oidc, strict: true });

    expect(await screen.findByRole('heading', { level: 1, name: 'Teacher' })).toBeInTheDocument();
    expect(oidc.signinRedirectCallback).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/teacher');
  });

  it('never returns to an address on another site', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));
    const oidc = new FakeOidc(fakeUser({ returnTo: '//evil.example.com' }));

    renderApp({ route: '/auth/callback?code=abc&state=xyz', oidc });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your results' }),
    ).toBeInTheDocument();
  });

  it("shows Cognito's reason without its wrapper, and lets the person try again", async () => {
    const oidc = new FakeOidc();
    oidc.signinRedirectCallback.mockRejectedValue(
      Object.assign(new Error('invalid_request'), {
        error_description:
          'PreSignUp failed with error Sign-up is limited to college email addresses.',
      }),
    );

    renderApp({ route: '/auth/callback?error=invalid_request', oidc });

    expect(await screen.findByRole('heading', { name: 'Sign-in failed' })).toBeInTheDocument();
    expect(screen.getByText('Sign-up is limited to college email addresses.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/' } });
  });

  it('fails cleanly when opened without a sign-in in progress', async () => {
    const oidc = new FakeOidc();

    renderApp({ route: '/auth/callback', oidc });

    expect(await screen.findByRole('heading', { name: 'Sign-in failed' })).toBeInTheDocument();
  });
});

describe('sign-out', () => {
  it('forgets the user, then leaves through the Cognito logout URL', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));
    const navigateExternal = vi.fn();
    const oidc = new FakeOidc(fakeUser());

    renderApp({ oidc, navigateExternal });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(navigateExternal).toHaveBeenCalledTimes(1));
    expect(oidc.removeUser).toHaveBeenCalled();
    const url = new URL(navigateExternal.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://auth.example.com/logout');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    // The page the app is served from, not a configured address.
    expect(url.searchParams.get('logout_uri')).toBe(`${window.location.origin}/`);
    expect(buildLogoutUrl(CONFIG)).toBe(url.toString());
  });
});

describe('a visitor who is not signed in', () => {
  it('waits for a click, with no redirect and no message', async () => {
    const oidc = new FakeOidc();

    renderApp({ oidc });

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
    expect(screen.queryByText('Your session has ended. Sign in again.')).not.toBeInTheDocument();
  });
});

describe('a session that cannot be renewed while the app is open', () => {
  it('returns to the landing page with a message', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));
    const oidc = new FakeOidc(fakeUser());

    renderApp({ oidc });
    await screen.findByRole('heading', { level: 1, name: 'Your results' });
    oidc.failRenewal();

    expect(await screen.findByText('Your session has ended. Sign in again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(oidc.removeUser).toHaveBeenCalled();
  });
});

describe('the real sign-in settings', () => {
  it('asks Cognito for the code flow with PKCE, going straight to Google', async () => {
    const protocol = new ProtocolClient(
      createUserManager(CONFIG, 'https://exam.example.com').settings,
    );

    const request = await protocol.createSigninRequest({ state: { returnTo: '/' } });
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://exam.example.com/auth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('returns to the origin the app is served from by default', () => {
    const settings = createUserManager(CONFIG).settings;

    expect(settings.redirect_uri).toBe(`${window.location.origin}/auth/callback`);
    expect(settings.post_logout_redirect_uri).toBe(`${window.location.origin}/`);
  });

  it('renews in the background, shortly before the access token expires, with the refresh token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 'sub-1', iss: 'x', aud: CONFIG.clientId, iat: now };
    const grants: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `${CONFIG.cognitoDomain}/oauth2/token`) {
          grants.push(String(init?.body));
          return jsonResponse({
            id_token: jwt({ ...claims, exp: now + 3600 }),
            access_token: 'renewed-access',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        return jsonResponse({}, 404);
      }),
    );
    const manager = createUserManager(CONFIG);
    expect(manager.settings.automaticSilentRenew).toBe(true);
    // The access token is inside the 60 second "expiring" window, so renewal starts on its own.
    await manager.storeUser(
      fakeUser(undefined, {
        idToken: jwt({ ...claims, exp: now + 30 }),
        idTokenExpiresIn: 30,
        accessTokenExpiresIn: 30,
      }),
    );
    expect(await manager.getUser()).not.toBeNull(); // loading the user starts the expiry timers

    await waitFor(() => expect(grants).toHaveLength(1), { timeout: 5000 });

    const form = new URLSearchParams(grants[0]);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('the-refresh-token');
    await manager.removeUser();
    manager.stopSilentRenew();
  });
});

describe('appUrls', () => {
  it('puts the callback and the home page on the given origin', () => {
    expect(appUrls('https://exam.vercel.app')).toEqual({
      redirectUri: 'https://exam.vercel.app/auth/callback',
      logoutUri: 'https://exam.vercel.app/',
    });
    expect(appUrls('http://localhost:5173/').redirectUri).toBe(
      'http://localhost:5173/auth/callback',
    );
  });
});

describe('helpers', () => {
  it('only accepts same-site paths to return to', () => {
    expect(safeReturnPath('/teacher?x=1')).toBe('/teacher?x=1');
    expect(safeReturnPath('//evil.example.com')).toBe('/');
    expect(safeReturnPath('https://evil.example.com')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
  });

  it('describes sign-in errors for people', () => {
    expect(describeSignInError({ error_description: 'PreSignUp failed with error Nope.' })).toBe(
      'Nope.',
    );
    expect(describeSignInError(new Error('No state in response'))).toBe('No state in response');
    expect(describeSignInError(undefined)).toBe('Sign-in could not be completed.');
  });
});
