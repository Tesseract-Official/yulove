import { Link, Navigate, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../../session/MeContext.js';
import { PageHeader } from '../common/ui.js';

/**
 * The appeals pages used to be in the batch manager's section. A bookmark or link to one lands
 * here: a super admin is sent on to the same page under Teacher; a batch manager is told appeals
 * are not theirs any more.
 */
export function LegacyAppeals() {
  const me = useCurrentUser();
  const { pathname, search } = useLocation();

  if (me.role === 'SUPER_ADMIN') {
    return <Navigate to={`${pathname.replace(/^\/manager/, '/teacher')}${search}`} replace />;
  }
  return (
    <section className="page">
      <PageHeader title="Not allowed" backTo="/manager" />
      <p>
        Appeals are handled by teachers now, so you can no longer open them here. You can still
        grade answers again from <Link to="/manager/board">Check grading and publish</Link>.
      </p>
    </section>
  );
}
