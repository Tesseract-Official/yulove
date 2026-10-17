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
  /** The ID token for API calls; renewed when expired or when `forceRefresh` is set. */
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

// sessionStorage only, and nothing secret: whether this tab has signed in, and when it last tried
// to sign in by itself.
const SIGNED_IN_HINT = 'yulove.signedIn';
const AUTO_SIGN_IN_AT = 'yulove.autoSignInAt';
const AUTO_SIGN_IN_GAP_MS = 10_000;

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function hasSignedInHint(): boolean {
  return storage()?.getItem(SIGNED_IN_HINT) === '1';
}

function setSignedInHint(on: boolean): void {
  if (on) storage()?.setItem(SIGNED_IN_HINT, '1');
  else storage()?.removeItem(SIGNED_IN_HINT);
}

/**
 * True when this tab signed in before and has not just tried to sign in on its own. The in-memory
 * session is gone after a reload; Cognito's session cookie makes the round trip instant. The gap
 * stops a loop if the round trip keeps failing or the person presses Back.
 */
export function shouldAutoSignIn(now: number = Date.now()): boolean {
  if (!hasSignedInHint()) return false;
  const last = Number(storage()?.getItem(AUTO_SIGN_IN_AT) ?? 0);
  return !(now - last < AUTO_SIGN_IN_GAP_MS);
}

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

  const apply = useCallback((user: User | null) => {
    setUserId(user?.profile.sub);
    setStatus(user && !user.expired ? 'signedIn' : 'signedOut');
  }, []);

  useEffect(() => {
    let active = true;
    const onLoaded = (user: User) => apply(user);
    const onUnloaded = () => apply(null);
    const onRenewError = () => {
      setSignedInHint(false);
      setNotice('Your session has ended. Sign in again.');
      void oidc.removeUser();
    };

    oidc.events.addUserLoaded(onLoaded);
    oidc.events.addUserUnloaded(onUnloaded);
    oidc.events.addSilentRenewError(onRenewError);
    void oidc.getUser().then(
      (user) => active && apply(user),
      () => active && apply(null),
    );
    return () => {
      active = false;
      oidc.events.removeUserLoaded(onLoaded);
      oidc.events.removeUserUnloaded(onUnloaded);
      oidc.events.removeSilentRenewError(onRenewError);
    };
  }, [oidc, apply]);

  const signIn = useCallback(
    async (returnTo = '/') => {
      storage()?.setItem(AUTO_SIGN_IN_AT, String(Date.now()));
      await oidc.signinRedirect({ state: { returnTo: safeReturnPath(returnTo) } });
    },
    [oidc],
  );

  const completeSignIn = useCallback(() => {
    // React StrictMode runs effects twice in development. The authorization code can be used once,
    // so both runs share the one exchange.
    const key = window.location.search;
    if (callback.current?.key === key) return callback.current.promise;

    const promise = oidc.signinRedirectCallback().then(
      (user) => {
        setSignedInHint(true);
        setNotice(undefined);
        apply(user);
        const state = user.state as { returnTo?: unknown } | undefined;
        return safeReturnPath(state?.returnTo);
      },
      (error: unknown) => {
        setSignedInHint(false);
        throw error;
      },
    );
    callback.current = { key, promise };
    return promise;
  }, [oidc, apply]);

  const signOut = useCallback(async () => {
    setSignedInHint(false);
    await oidc.removeUser();
    goTo(buildLogoutUrl(config));
  }, [oidc, config, goTo]);

  const getIdToken = useCallback(
    async (forceRefresh = false) => {
      let user = await oidc.getUser();
      if (!user) return null;
      if (forceRefresh || user.expired) {
        try {
          user = await oidc.signinSilent();
        } catch {
          return null;
        }
      }
      return user?.id_token ?? null;
    },
    [oidc],
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
