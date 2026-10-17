import {
  UserManager,
  WebStorageStateStore,
  type User,
  type SigninRedirectArgs,
} from 'oidc-client-ts';
import type { AppConfig } from '../config/config.js';

/** The part of oidc-client-ts's UserManager that the app uses, so tests can supply a fake. */
export interface OidcClient {
  getUser(): Promise<User | null>;
  signinRedirect(args?: SigninRedirectArgs): Promise<void>;
  signinRedirectCallback(url?: string): Promise<User>;
  signinSilent(): Promise<User | null>;
  removeUser(): Promise<void>;
  events: {
    addUserLoaded(callback: (user: User) => void): void;
    removeUserLoaded(callback: (user: User) => void): void;
    addUserUnloaded(callback: () => void): void;
    removeUserUnloaded(callback: () => void): void;
    addSilentRenewError(callback: (error: Error) => void): void;
    removeSilentRenewError(callback: (error: Error) => void): void;
  };
}

/** The sign-in return page and the post-logout page, on the origin the app is served from. */
export function appUrls(origin: string): { redirectUri: string; logoutUri: string } {
  const base = origin.replace(/\/+$/, '');
  return { redirectUri: `${base}/auth/callback`, logoutUri: `${base}/` };
}

/**
 * Authorization code + PKCE against the Cognito hosted UI, going straight to Google.
 *
 * The user (with its tokens) is kept in sessionStorage, so a reload restores the session in the
 * same tab, while closing the tab ends it. localStorage is never used. Tokens are renewed with the
 * Cognito refresh token (a refresh_token grant at the token endpoint), both when the app starts
 * with tokens that expired or are about to and automatically shortly before the access token
 * expires. Cognito's code flow always issues a refresh token and the app only renews users that
 * have one, so the library's hidden-iframe fallback (which the hosted UI would refuse) is never
 * used. The PKCE verifier and state of a sign-in in progress live in sessionStorage too.
 */
export function createUserManager(
  config: AppConfig,
  origin: string = window.location.origin,
): UserManager {
  const domain = config.cognitoDomain;
  const { redirectUri, logoutUri } = appUrls(origin);
  return new UserManager({
    authority: domain,
    // Cognito's endpoints are fixed paths on the hosted UI domain, so nothing is discovered.
    metadata: {
      issuer: domain,
      authorization_endpoint: `${domain}/oauth2/authorize`,
      token_endpoint: `${domain}/oauth2/token`,
      userinfo_endpoint: `${domain}/oauth2/userInfo`,
    },
    client_id: config.clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: logoutUri,
    response_type: 'code',
    scope: 'openid email profile',
    extraQueryParams: { identity_provider: 'Google' },
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    // Renews shortly before the access token expires, with the refresh token.
    automaticSilentRenew: true,
    loadUserInfo: false,
  });
}

/** Cognito's logout endpoint; it ends the hosted UI session and returns to the app's home page. */
export function buildLogoutUrl(config: AppConfig, origin: string = window.location.origin): string {
  const url = new URL(`${config.cognitoDomain}/logout`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', appUrls(origin).logoutUri);
  return url.toString();
}

/** Only same-site paths are accepted as a place to return to after signing in. */
export function safeReturnPath(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
}

/** Cognito wraps a pre-sign-up rejection as "PreSignUp failed with error <message>". */
export function describeSignInError(error: unknown): string {
  const description =
    typeof error === 'object' && error !== null
      ? (error as { error_description?: unknown }).error_description
      : undefined;
  if (typeof description === 'string' && description.trim() !== '') {
    return description.replace(/^PreSignUp failed with error\s*/i, '').trim();
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Sign-in could not be completed.';
}
