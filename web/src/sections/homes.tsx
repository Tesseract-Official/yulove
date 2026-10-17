import { useCurrentUser } from '../session/MeContext.js';
import { ROLE_LABEL } from '../session/roles.js';
import { EmptyState } from '../ui/states.js';

function PlaceholderHome({ title, intro }: { title: string; intro: string }) {
  const me = useCurrentUser();
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">{intro}</p>
      <dl className="facts">
        <dt>Signed in as</dt>
        <dd>
          {me.name} ({me.email})
        </dd>
        <dt>Role</dt>
        <dd>{ROLE_LABEL[me.role]}</dd>
      </dl>
      <h2>Batches</h2>
      {me.batches.length === 0 ? (
        <EmptyState title="No batches yet">Batches assigned to you will appear here.</EmptyState>
      ) : (
        <ul className="list">
          {me.batches.map((batch) => (
            <li key={batch.batchId}>{batch.name}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TeacherHome() {
  return (
    <PlaceholderHome
      title="Teacher"
      intro="Questions, exams, results and appeals will live here."
    />
  );
}

export function StudentHome() {
  return (
    <PlaceholderHome title="Student" intro="Your published results and appeals will live here." />
  );
}
