import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { StaffMember, StaffRole } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { ActiveToggle } from '../common/ActiveToggle.js';
import { keys, useBatches } from '../common/hooks.js';
import { INACTIVE_LABEL } from '../common/labels.js';
import { useQuery } from '@tanstack/react-query';
import { Chip, Field, Notice, PageHeader } from '../common/ui.js';

const ROLE_NAME: Record<StaffRole, string> = {
  TEACHER: 'Teacher',
  BATCH_MANAGER: 'Batch manager',
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Batch = { batchId: string; name: string };

/** A list of checkboxes, one per batch: the easy multi-select on a phone. */
function BatchChecklist({
  legend,
  batches,
  selected,
  onChange,
}: {
  legend: string;
  batches: Batch[];
  selected: string[];
  onChange: (batchIds: string[]) => void;
}) {
  if (batches.length === 0) {
    return <p className="muted">There are no batches yet. Add one under Batches first.</p>;
  }
  return (
    <fieldset className="checklist">
      <legend>{legend}</legend>
      {batches.map((batch) => (
        <label key={batch.batchId} className="check">
          <input
            type="checkbox"
            checked={selected.includes(batch.batchId)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, batch.batchId]
                  : selected.filter((id) => id !== batch.batchId),
              )
            }
          />
          <span>{batch.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function StaffCard({ member, batches }: { member: StaffMember; batches: Batch[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(member.batchIds);
  const [problem, setProblem] = useState<string | undefined>();

  const nameOf = (id: string) => batches.find((b) => b.batchId === id)?.name ?? id;

  const save = useMutation({
    mutationFn: () => api.assignBatches(member.email, selected),
    meta: { errorToast: false },
    onSuccess: async () => {
      setEditing(false);
      setProblem(undefined);
      await queryClient.invalidateQueries({ queryKey: keys.staff });
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  return (
    <li className={`card-item${member.active ? '' : ' is-inactive'}`}>
      <div className="card-head">
        <span className="row-title">{member.name}</span>
        {!member.active ? <Chip tone="bad">{INACTIVE_LABEL}</Chip> : null}
      </div>
      <p className="muted break">{member.email}</p>
      <p className="actions">
        <ActiveToggle
          person={member}
          onChanged={() => queryClient.invalidateQueries({ queryKey: keys.staff })}
        />
      </p>

      {editing ? (
        <div className="form">
          <BatchChecklist
            legend={`Batches for ${member.name}`}
            batches={batches}
            selected={selected}
            onChange={setSelected}
          />
          {problem ? <Notice kind="error">{problem}</Notice> : null}
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save batches'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditing(false);
                setSelected(member.batchIds);
                setProblem(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="chips" aria-label={`Batches of ${member.name}`}>
            {member.batchIds.length === 0 ? (
              <span className="muted">No batches yet</span>
            ) : (
              member.batchIds.map((id) => <Chip key={id}>{nameOf(id)}</Chip>)
            )}
          </p>
          <button
            type="button"
            className="button"
            aria-label={`Change batches for ${member.name}`}
            onClick={() => {
              setSelected(member.batchIds);
              setEditing(true);
            }}
          >
            Change batches
          </button>
        </>
      )}
    </li>
  );
}

function AddStaffForm({ batches }: { batches: Batch[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('TEACHER');
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const [added, setAdded] = useState<string | undefined>();

  const create = useMutation({
    mutationFn: () => api.createStaff({ name: name.trim(), email: email.trim(), role, batchIds }),
    meta: { errorToast: false },
    onSuccess: async (result) => {
      setAdded(`Added ${result.user.name}. They can now sign in with ${result.user.email}.`);
      setName('');
      setEmail('');
      setBatchIds([]);
      await queryClient.invalidateQueries({ queryKey: keys.staff });
    },
    onError: (error) => {
      setAdded(undefined);
      setProblem(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAdded(undefined);
    if (name.trim() === '') return setProblem('Type the person’s name.');
    if (!EMAIL_SHAPE.test(email.trim())) {
      return setProblem('Type a valid college email address, for example name@college.edu.');
    }
    setProblem(undefined);
    create.mutate();
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field label="Name">
        {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="College email" hint="They sign in with this Google account.">
        {(id) => (
          <input
            id={id}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="off"
          />
        )}
      </Field>
      <Field label="Role">
        {(id) => (
          <select id={id} value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            <option value="TEACHER">Teacher</option>
            <option value="BATCH_MANAGER">Batch manager</option>
          </select>
        )}
      </Field>
      <BatchChecklist
        legend="Batches (you can change these later)"
        batches={batches}
        selected={batchIds}
        onChange={setBatchIds}
      />
      {problem ? <Notice kind="error">{problem}</Notice> : null}
      {added ? <Notice kind="success">{added}</Notice> : null}
      <button type="submit" className="button button-primary" disabled={create.isPending}>
        {create.isPending ? 'Adding…' : 'Add person'}
      </button>
    </form>
  );
}

/** Super admin: teachers and batch managers, their batches, and a form to add someone. */
export function StaffPage() {
  const api = useApi();
  const batches = useBatches();
  const staff = useQuery({
    queryKey: keys.staff,
    queryFn: async () => (await api.listStaff()).staff,
    meta: { errorToast: false },
  });

  const lists = (['TEACHER', 'BATCH_MANAGER'] as const).map((role) => ({
    role,
    members: staff.data?.filter((m) => m.role === role) ?? [],
  }));

  return (
    <section className="page">
      <PageHeader title="Teachers and batch managers" backTo="/admin" />

      <h2>Add a person</h2>
      <AddStaffForm batches={batches.data ?? []} />

      {staff.isPending ? (
        <Loading label="Loading people…" />
      ) : staff.isError ? (
        <ErrorState
          title="Could not load the list"
          message={errorMessage(staff.error)}
          onRetry={() => void staff.refetch()}
        />
      ) : (
        lists.map(({ role, members }) => (
          <div key={role}>
            <h2>{role === 'TEACHER' ? 'Teachers' : 'Batch managers'}</h2>
            {members.length === 0 ? (
              <EmptyState title={`No ${ROLE_NAME[role].toLowerCase()}s yet`}>
                Add one with the form above.
              </EmptyState>
            ) : (
              <ul className="cards">
                {members.map((member) => (
                  <StaffCard key={member.email} member={member} batches={batches.data ?? []} />
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </section>
  );
}
