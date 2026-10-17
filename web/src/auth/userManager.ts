import {
  InMemoryWebStorage,
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

/**
 * Authorization code + PKCE against the Cognito hosted UI, going straight to Google.
 *
 * Tokens live only in memory (a page reload signs in again, which Cognito's own session makes
 * quick). The sign-in state that has to survive the trip to Cognito, the PKCE verifier and state
 * id, goes in sessionStorage; it holds no token.
 */
export function createUserManager(config: AppConfig): UserManager {
  const domain = config.cognitoDomain;
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
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.logoutUri,
    response_type: 'code',
    scope: 'openid email profile',
    extraQueryParams: { identity_provider: 'Google' },
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    loadUserInfo: false,
  });
}

/** Cognito's logout endpoint; it ends the hosted UI session and returns to `logoutUri`. */
export function buildLogoutUrl(config: AppConfig): string {
  const url = new URL(`${config.cognitoDomain}/logout`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', config.logoutUri);
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
