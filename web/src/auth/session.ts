import type { User } from 'oidc-client-ts';

/** Shown on the landing page when a session could not be kept alive. */
export const SESSION_ENDED = 'Your session has ended. Sign in again.';

/** A token that expires within this many seconds is renewed before it is used. */
export const RENEW_SKEW_SECONDS = 60;

/**
 * Seconds until the first of the tokens the app depends on expires: the ID token (what the API
 * checks) or the access token. Undefined when neither says.
 */
export function secondsLeft(
  user: User,
  nowSeconds: number = Date.now() / 1000,
): number | undefined {
  const expiries = [user.profile.exp, user.expires_at].filter(
    (value): value is number => typeof value === 'number',
  );
  return expiries.length === 0 ? undefined : Math.min(...expiries) - nowSeconds;
}

/** True when the user's tokens have expired or are about to. */
export function needsRenewal(user: User, nowSeconds?: number): boolean {
  const left = secondsLeft(user, nowSeconds);
  return left !== undefined && left <= RENEW_SKEW_SECONDS;
}

/** Renewal needs the refresh token; without one the only way back in is to sign in again. */
export function canRenew(user: User): boolean {
  return typeof user.refresh_token === 'string' && user.refresh_token !== '';
}
