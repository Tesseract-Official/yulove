import { useEffect, useRef, useState } from 'react';
import { shouldAutoSignIn, useAuth } from './AuthContext.js';

/**
 * After a reload the in-memory session is gone. If this tab had signed in, go back through Cognito
 * on our own (it answers from its session cookie). Returns true while that is going on.
 */
export function useAutoSignIn(returnTo: string): boolean {
  const { status, signIn } = useAuth();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  const active = status === 'signedOut' && !failed && (started.current || shouldAutoSignIn());

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    signIn(returnTo).catch(() => setFailed(true));
  }, [active, signIn, returnTo]);

  return active;
}
