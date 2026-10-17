import { MenuCard } from '../common/ui.js';

/** The batch manager menu. */
export function ManagerHome() {
  return (
    <section className="page">
      <h1>Batch manager</h1>
      <p className="muted">What would you like to do?</p>
      <div className="menu-grid">
        <MenuCard to="/manager/import" title="Add students">
          Upload a CSV file with your students’ names, emails and roll numbers.
        </MenuCard>
        <MenuCard to="/manager/upload" title="Upload answers">
          Photograph each student’s answer pages and send them for grading.
        </MenuCard>
        <MenuCard to="/manager/board" title="Check grading and publish">
          See how every answer is doing, grade failed ones again, and publish the results.
        </MenuCard>
      </div>
    </section>
  );
}
