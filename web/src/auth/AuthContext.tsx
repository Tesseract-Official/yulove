import type { User } from 'oidc-client-ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useConfig } from '../config/ConfigContext.js';
import { SESSION_ENDED, canRenew, needsRenewal } from './session.js';
import {
  buildLogoutUrl,
  createUserManager,
  safeReturnPath,
  type OidcClient,
} from './userManager.js';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

export interface AuthValue {
  status: AuthStatus;
  /** The Cognito subject of the signed-in user. */
  userId: string | undefined;
  /** Why the session ended, shown on the landing page. */
  notice: string | undefined;
  /** Sends the browser to Google (through Cognito) and back to `returnTo`. */
  signIn(returnTo?: string): Promise<void>;
  /** Finishes the redirect on /auth/callback. Resolves to the path to open next. */
  completeSignIn(): Promise<string>;
  /** Forgets the user and signs out of Cognito. */
  signOut(): Promise<void>;
  /**
   * The ID token for API calls. It is renewed with the refresh token when it has expired or is about
   * to, or when `forceRefresh` is set; null when there is no session or it cannot be renewed.
   */
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

const defaultNavigate = (url: string) => window.location.assign(url);

export interface AuthProviderProps {
  children: ReactNode;
  /** Tests supply a fake. */
  client?: OidcClient;
  /** Leaves the app for another site (Cognito's logout page). Tests supply a spy. */
  navigateExternal?: (url: string) => void;
}

export function AuthProvider({ children, client, navigateExternal }: AuthProviderProps) {
  const config = useConfig();
  const oidc = useMemo<OidcClient>(() => client ?? createUserManager(config), [client, config]);
  const goTo = navigateExternal ?? defaultNavigate;

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [userId, setUserId] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const callback = useRef<{ key: string; promise: Promise<string> } | null>(null);
  const renewal = useRef<Promise<User | null> | null>(null);

  const apply = useCallback((user: User | null) => {
    setUserId(user?.profile.sub);
    setStatus(user && !user.expired ? 'signedIn' : 'signedOut');
  }, []);

  /**
   * Renews the stored user with the refresh token. Concurrent callers (StrictMode's double effect,
   * several API calls at once) share one request. Resolves to null when renewal is impossible or
   * fails, which means the session is over.
   */
  const renew = useCallback((): Promise<User | null> => {
    renewal.current ??= (async () => {
      try {
        const stored = await oidc.getUser();
        if (!stored || !canRenew(stored)) return null;
        return await oidc.signinSilent();
      } catch {
        return null;
      } finally {
        renewal.current = null;
      }
    })();
    return renewal.current;
  }, [oidc]);

  /** The session cannot be kept: forget it and say so on the landing page. */
  const endSession = useCallback(async () => {
    setNotice(SESSION_ENDED);
    try {
      await oidc.removeUser();
    } finally {
      apply(null);
    }
  }, [oidc, apply]);

  useEffect(() => {
    let active = true;
    const onLoaded = (user: User) => apply(user);
    const onUnloaded = () => apply(null);
    const onRenewError = () => void endSession();

    oidc.events.addUserLoaded(onLoaded);
    oidc.events.addUserUnloaded(onUnloaded);
    oidc.events.addSilentRenewError(onRenewError);

    // On startup the user comes back from sessionStorage. A reload within the token's life just
    // continues; tokens that expired or are about to are renewed first. Only a failed renewal ends
    // the session. Nobody stored at all is a plain visit, with no message.
    void (async () => {
      const user = await oidc.getUser().catch(() => null);
      if (!active) return;
      if (!user) return apply(null);
      if (!needsRenewal(user)) return apply(user);

      const renewed = await renew();
      if (!active) return;
      if (renewed) apply(renewed);
      else await endSession();
    })();

    return () => {
      active = false;
      oidc.events.removeUserLoaded(onLoaded);
      oidc.events.removeUserUnloaded(onUnloaded);
      oidc.events.removeSilentRenewError(onRenewError);
    };
  }, [oidc, apply, renew, endSession]);

  const signIn = useCallback(
    async (returnTo = '/') => {
      await oidc.signinRedirect({ state: { returnTo: safeReturnPath(returnTo) } });
    },
    [oidc],
  );

  const completeSignIn = useCallback(() => {
    // React StrictMode runs effects twice in development. The authorization code can be used once,
    // so both runs share the one exchange.
    const key = window.location.search;
    if (callback.current?.key === key) return callback.current.promise;

    const promise = oidc.signinRedirectCallback().then((user) => {
      setNotice(undefined);
      apply(user);
      const state = user.state as { returnTo?: unknown } | undefined;
      return safeReturnPath(state?.returnTo);
    });
    callback.current = { key, promise };
    return promise;
  }, [oidc, apply]);

  const signOut = useCallback(async () => {
    // Removes the user, and with it the tokens, from sessionStorage.
    await oidc.removeUser();
    goTo(buildLogoutUrl(config));
  }, [oidc, config, goTo]);

  const getIdToken = useCallback(
    async (forceRefresh = false) => {
      let user = await oidc.getUser();
      if (!user) return null;
      if (forceRefresh || needsRenewal(user)) {
        user = await renew();
        if (!user) return null;
      }
      return user.id_token ?? null;
    },
    [oidc, renew],
  );

  const value = useMemo<AuthValue>(
    () => ({ status, userId, notice, signIn, completeSignIn, signOut, getIdToken }),
    [status, userId, notice, signIn, completeSignIn, signOut, getIdToken],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
