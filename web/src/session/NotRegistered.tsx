import { useAuth } from '../auth/AuthContext.js';

/** Shown when GET /me answers 403: signed in with Google, but not a registered user or switched off (inactive). */
export function NotRegistered() {
  const { signOut } = useAuth();
  return (
    <main className="centered">
      <div className="card">
        <h1>Not registered</h1>
        <p>
          Your account isn't registered, or it has been made inactive. Contact your batch manager.
        </p>
        <button type="button" className="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </main>
  );
}
