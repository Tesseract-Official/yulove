import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OidcClient as ProtocolClient } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG,
  FakeOidc,
  fakeUser,
  jsonResponse,
  meFor,
  renderApp,
  stubApi,
} from '../test/helpers.js';
import {
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

    expect(await screen.findByRole('heading', { level: 1, name: 'Student' })).toBeInTheDocument();
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
    expect(url.searchParams.get('logout_uri')).toBe('http://localhost:5173/');
    expect(buildLogoutUrl(CONFIG)).toBe(url.toString());
  });
});

describe('signing in again after a reload', () => {
  it('goes straight back through Cognito when this tab signed in before', async () => {
    window.sessionStorage.setItem('yulove.signedIn', '1');
    const oidc = new FakeOidc();

    renderApp({ route: '/teacher', oidc });

    await waitFor(() =>
      expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/teacher' } }),
    );
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();
  });

  it('does not loop when it just tried', async () => {
    window.sessionStorage.setItem('yulove.signedIn', '1');
    window.sessionStorage.setItem('yulove.autoSignInAt', String(Date.now()));
    const oidc = new FakeOidc();

    renderApp({ oidc });

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
  });

  it('waits for a click in a tab that never signed in', async () => {
    const oidc = new FakeOidc();

    renderApp({ oidc });

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
  });

  it('returns to the landing page with a notice when the session cannot be renewed', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));
    const oidc = new FakeOidc(fakeUser());

    renderApp({ oidc });
    await screen.findByRole('heading', { level: 1, name: 'Student' });
    oidc.failRenewal();

    expect(await screen.findByText('Your session has ended. Sign in again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem('yulove.signedIn')).toBeNull();
  });
});

describe('the real sign-in settings', () => {
  it('asks Cognito for the code flow with PKCE, going straight to Google', async () => {
    const protocol = new ProtocolClient(createUserManager(CONFIG).settings);

    const request = await protocol.createSigninRequest({ state: { returnTo: '/' } });
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('keeps tokens in memory only', async () => {
    const manager = createUserManager(CONFIG);

    await manager.storeUser(fakeUser());

    expect((await manager.getUser())?.id_token).toBe('the-id-token');
    expect(window.localStorage.length).toBe(0);
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const value = window.sessionStorage.getItem(window.sessionStorage.key(i)!) ?? '';
      expect(value).not.toContain('the-id-token');
      expect(value).not.toContain('the-access-token');
    }
  });

  it('renews quietly before the token expires', () => {
    expect(createUserManager(CONFIG).settings.automaticSilentRenew).toBe(true);
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
