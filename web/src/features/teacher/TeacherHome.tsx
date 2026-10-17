import { MenuCard } from '../common/ui.js';

/** The teacher menu. */
export function TeacherHome() {
  return (
    <section className="page">
      <h1>Teacher</h1>
      <p className="muted">What would you like to do?</p>
      <div className="menu-grid">
        <MenuCard to="/teacher/questions" title="Questions">
          Write questions, make their tests and approve them.
        </MenuCard>
        <MenuCard to="/teacher/exams" title="Exams">
          Build an exam from approved questions and make its PDF.
        </MenuCard>
        <MenuCard to="/teacher/results" title="Results">
          See every student’s marks and check any answer.
        </MenuCard>
        <MenuCard to="/teacher/appeals" title="Appeals">
          Read what students wrote about a mark and decide what to do about it.
        </MenuCard>
      </div>
    </section>
  );
}
