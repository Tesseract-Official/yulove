import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.js';
import { useCurrentUser } from '../session/MeContext.js';
import { ROLE_HOME, ROLE_LABEL, allowedSections } from '../session/roles.js';
import { UnsentBanner } from '../features/manager/UploadStatus.js';
import { UploadQueueProvider } from '../features/manager/uploadQueue.js';

/**
 * Header (name, role, sign out, and the section switcher for super admins) around every section.
 * The photo upload queue lives here, above the pages, so photos keep going up while a batch manager
 * moves around the app.
 */
export function Shell() {
  const me = useCurrentUser();
  const { signOut } = useAuth();
  const sections = allowedSections(me.role);

  return (
    <UploadQueueProvider>
      <div className="app">
        <header className="topbar">
          <div className="topbar-row">
            <span className="brand">Paper DSA Exam Judge</span>
            <div className="user">
              <span className="user-name">{me.name}</span>
              <span className="pill">{ROLE_LABEL[me.role]}</span>
              <button type="button" className="button button-quiet" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
          {sections.length > 1 ? (
            <nav className="switcher" aria-label="Sections">
              {sections.map((role) => (
                <NavLink key={role} to={ROLE_HOME[role]} className="switcher-link">
                  {ROLE_LABEL[role]}
                </NavLink>
              ))}
            </nav>
          ) : null}
        </header>
        <UnsentBanner />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </UploadQueueProvider>
  );
}
