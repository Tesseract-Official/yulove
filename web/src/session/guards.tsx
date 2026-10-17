import type { Role } from '@yulove/shared';
import { Navigate, Outlet } from 'react-router-dom';
import { useCurrentUser } from './MeContext.js';
import { ROLE_HOME, allowedSections } from './roles.js';

/** Lets a user into a section only if their role may open it; anyone else goes to their own home. */
export function RequireSection({ section }: { section: Role }) {
  const me = useCurrentUser();
  if (!allowedSections(me.role).includes(section)) {
    return <Navigate to={ROLE_HOME[me.role]} replace />;
  }
  return <Outlet />;
}

/** `/` once signed in: straight to the user's own section. */
export function RoleRedirect() {
  const me = useCurrentUser();
  return <Navigate to={ROLE_HOME[me.role]} replace />;
}
