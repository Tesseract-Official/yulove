import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/ApiContext.js';
import { ApiError, errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { keys, useBatches } from '../common/hooks.js';
import { Field, Notice, PageHeader } from '../common/ui.js';

// The same rule the API applies to a batch ID.
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Super admin: the list of batches, and a form to add one. */
export function BatchesPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const batches = useBatches();
  const [batchId, setBatchId] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [added, setAdded] = useState<string | undefined>();

  const create = useMutation({
    mutationFn: (body: { batchId: string; name: string }) => api.createBatch(body),
    meta: { errorToast: false },
    onSuccess: async (result) => {
      setAdded(`Added ${result.batch.name} (ID ${result.batch.batchId}).`);
      setBatchId('');
      setName('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.batches }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ]);
    },
    onError: (error) => {
      setAdded(undefined);
      setProblem(
        error instanceof ApiError && error.status === 409
          ? 'A batch with this ID already exists. Choose a different ID.'
          : errorMessage(error),
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAdded(undefined);
    const id = batchId.trim();
    const title = name.trim();
    if (!BATCH_ID.test(id)) {
      return setProblem(
        'The batch ID can only use letters, numbers, - and _, and must start with a letter or number.',
      );
    }
    if (title === '') return setProblem('Type a name for the batch.');
    setProblem(undefined);
    create.mutate({ batchId: id, name: title });
  };

  return (
    <section className="page">
      <PageHeader title="Batches" backTo="/admin" />

      <h2>Add a batch</h2>
      <form className="form" onSubmit={submit} noValidate>
        <Field
          label="Batch ID"
          hint="Short and without spaces, for example 2026-A. This is what goes in the “batch” column of the student CSV."
        >
          {(id) => (
            <input
              id={id}
              value={batchId}
              onChange={(event) => setBatchId(event.target.value)}
              autoCapitalize="off"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Batch name" hint="What people see, for example “2026 Morning”.">
          {(id) => <input id={id} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        {problem ? <Notice kind="error">{problem}</Notice> : null}
        {added ? <Notice kind="success">{added}</Notice> : null}
        <button type="submit" className="button button-primary" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add batch'}
        </button>
      </form>

      <h2>All batches</h2>
      {batches.isPending ? (
        <Loading label="Loading batches…" />
      ) : batches.isError ? (
        <ErrorState
          title="Could not load the batches"
          message={errorMessage(batches.error)}
          onRetry={() => void batches.refetch()}
        />
      ) : batches.data.length === 0 ? (
        <EmptyState title="No batches yet">Add the first batch with the form above.</EmptyState>
      ) : (
        <ul className="rows">
          {batches.data.map((batch) => (
            <li key={batch.batchId} className="row">
              <span className="row-title">{batch.name}</span>
              <span className="muted">ID: {batch.batchId}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
