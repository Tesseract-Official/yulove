import { MenuCard } from '../common/ui.js';

/** The super admin menu. */
export function AdminHome() {
  return (
    <section className="page">
      <h1>Admin</h1>
      <p className="muted">What would you like to do?</p>
      <div className="menu-grid">
        <MenuCard to="/admin/staff" title="Teachers and batch managers">
          See who has an account, add people, and choose which batches they look after.
        </MenuCard>
        <MenuCard to="/admin/batches" title="Batches">
          See the batches and add a new one.
        </MenuCard>
      </div>
    </section>
  );
}
