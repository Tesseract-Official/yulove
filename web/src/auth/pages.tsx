import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RoleRedirect } from '../session/guards.js';
import { SessionGate } from '../session/SessionGate.js';
import { errorMessage } from '../api/errors.js';
import { Loading } from '../ui/states.js';
import { useToast } from '../ui/Toaster.js';
import { useAuth } from './AuthContext.js';
import { useAutoSignIn } from './useAutoSignIn.js';
import { describeSignInError, safeReturnPath } from './userManager.js';

function LandingPage() {
  const { signIn, notice } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  const start = () => {
    setBusy(true);
    signIn(from).catch((error: unknown) => {
      setBusy(false);
      toast.notify(errorMessage(error));
    });
  };

  return (
    <main className="centered">
      <div className="card">
        <h1>Paper DSA Exam Judge</h1>
        <p className="muted">Sign in with your college Google account to see your section.</p>
        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        <button type="button" className="button button-primary" onClick={start} disabled={busy}>
          {busy ? 'Redirecting…' : 'Sign in with Google'}
        </button>
      </div>
    </main>
  );
}

/** `/`: the sign-in page, or, once signed in, a redirect to the user's own section. */
export function LandingRoute() {
  const { status } = useAuth();
  const signingIn = useAutoSignIn('/');

  if (status === 'loading') return <Loading />;
  if (signingIn) return <Loading label="Signing you in…" />;
  if (status === 'signedIn') {
    return (
      <SessionGate>
        <RoleRedirect />
      </SessionGate>
    );
  }
  return <LandingPage />;
}

/** `/auth/callback`: Cognito sends the browser back here with the authorization code. */
export function CallbackPage() {
  const { completeSignIn, signIn } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    completeSignIn().then(
      (returnTo) => {
        if (active) navigate(returnTo, { replace: true });
      },
      (reason: unknown) => {
        if (active) setError(describeSignInError(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [completeSignIn, navigate]);

  if (error !== undefined) {
    return (
      <main className="centered">
        <div className="card" role="alert">
          <h1>Sign-in failed</h1>
          <p>{error}</p>
          <button type="button" className="button button-primary" onClick={() => void signIn('/')}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  return <Loading label="Signing you in…" />;
}
