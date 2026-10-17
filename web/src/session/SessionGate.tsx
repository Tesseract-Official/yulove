import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.js';
import { useAutoSignIn } from '../auth/useAutoSignIn.js';
import { errorMessage } from '../api/errors.js';
import { ErrorState, Loading } from '../ui/states.js';
import { MeContext } from './MeContext.js';
import { NotRegistered } from './NotRegistered.js';
import { isNotRegistered, useMe } from './useMe.js';

/**
 * Everything behind sign-in. Signed-out visitors go to the landing page; signed-in users are looked
 * up with GET /me and the children only render once their role is known.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const signingIn = useAutoSignIn(returnTo);
  const me = useMe();

  if (status === 'loading') return <Loading />;
  if (status === 'signedOut') {
    return signingIn ? (
      <Loading label="Signing you in…" />
    ) : (
      <Navigate to="/" replace state={{ from: returnTo }} />
    );
  }

  if (me.isPending) return <Loading label="Loading your account…" />;
  if (me.isError) {
    if (isNotRegistered(me.error)) return <NotRegistered />;
    return (
      <div className="centered">
        <ErrorState
          title="Could not load your account"
          message={errorMessage(me.error)}
          onRetry={() => void me.refetch()}
        />
      </div>
    );
  }
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}
