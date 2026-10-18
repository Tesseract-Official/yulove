import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { StudentSummary } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { ActiveToggle } from '../common/ActiveToggle.js';
import { keys } from '../common/hooks.js';
import { INACTIVE_LABEL } from '../common/labels.js';
import { BatchSelect } from '../common/pickers.js';
import { Chip, Field, PageHeader } from '../common/ui.js';

/** Students matching what was typed: roll number, name or email, in any case. */
export function matchStudents(students: readonly StudentSummary[], search: string) {
  const text = search.trim().toLowerCase();
  if (text === '') return [...students];
  return students.filter(
    (s) =>
      (s.rollNo ?? '').toLowerCase().includes(text) ||
      s.name.toLowerCase().includes(text) ||
      s.email.toLowerCase().includes(text),
  );
}

function StudentRow({ student, batchId }: { student: StudentSummary; batchId: string }) {
  const queryClient = useQueryClient();
  return (
    <li className={`card-item${student.active ? '' : ' is-inactive'}`}>
      <div className="card-head">
        <span className="row-title">
          {student.rollNo ? `${student.rollNo} · ${student.name}` : student.name}
        </span>
        {!student.active ? <Chip tone="bad">{INACTIVE_LABEL}</Chip> : null}
      </div>
      <p className="muted break">{student.email}</p>
      <p className="actions">
        <ActiveToggle
          person={student}
          onChanged={() => queryClient.invalidateQueries({ queryKey: keys.students(batchId) })}
        />
      </p>
    </li>
  );
}

/** Batch manager: a batch's students, each with an Active / Inactive switch. */
export function StudentsPage() {
  const api = useApi();
  const [batchId, setBatchId] = useState('');
  const [search, setSearch] = useState('');

  const students = useQuery({
    queryKey: keys.students(batchId),
    queryFn: async () => (await api.listStudents(batchId)).students,
    enabled: batchId !== '',
    meta: { errorToast: false },
  });

  const shown = matchStudents(students.data ?? [], search);

  return (
    <section className="page">
      <PageHeader title="Students" backTo="/manager" />
      <p className="muted">
        Switch a student off if they have left. They can no longer sign in, but their marks and
        answers are kept. You can switch them on again.
      </p>
      <BatchSelect value={batchId} onChange={setBatchId} />

      {batchId === '' ? null : students.isPending ? (
        <Loading label="Loading students…" />
      ) : students.isError ? (
        <ErrorState
          title="Could not load the students"
          message={errorMessage(students.error)}
          onRetry={() => void students.refetch()}
        />
      ) : students.data.length === 0 ? (
        <EmptyState title="No students in this batch yet">
          Add them with Add students on the menu.
        </EmptyState>
      ) : (
        <>
          <Field label="Find a student" hint="Type a roll number, a name or an email.">
            {(id) => (
              <input
                id={id}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
          {shown.length === 0 ? (
            <EmptyState title="No student found">
              Check the spelling, or try the roll number.
            </EmptyState>
          ) : (
            <ul className="cards" aria-label="Students">
              {shown.map((student) => (
                <StudentRow key={student.email} student={student} batchId={batchId} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
