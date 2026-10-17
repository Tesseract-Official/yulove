import { useEffect } from 'react';
import type { ExamStatus } from '@yulove/shared';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { useBatches, useExams } from './hooks.js';
import { Field } from './ui.js';

/** Choose one of the caller's batches. With only one batch it is chosen for them. */
export function BatchSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (batchId: string) => void;
}) {
  const batches = useBatches();
  const only = batches.data?.length === 1 ? batches.data[0]?.batchId : undefined;

  useEffect(() => {
    if (only && value !== only) onChange(only);
  }, [only, value, onChange]);

  if (batches.isPending) return <Loading label="Loading your batches…" />;
  if (batches.isError) {
    return (
      <ErrorState
        title="Could not load your batches"
        message={errorMessage(batches.error)}
        onRetry={() => void batches.refetch()}
      />
    );
  }
  if (batches.data.length === 0) {
    return (
      <EmptyState title="No batches yet">
        You are not assigned to any batch. Ask an admin to add you to one.
      </EmptyState>
    );
  }

  return (
    <Field label="Batch">
      {(id) => (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose a batch…</option>
          {batches.data.map((batch) => (
            <option key={batch.batchId} value={batch.batchId}>
              {batch.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Choose one exam of a batch, from those with one of the given statuses. */
export function ExamSelect({
  batchId,
  value,
  onChange,
  statuses,
  emptyHint,
}: {
  batchId: string;
  value: string;
  onChange: (examId: string) => void;
  statuses: readonly ExamStatus[];
  /** Said when the batch has no exam to choose from. */
  emptyHint: string;
}) {
  const exams = useExams(batchId);
  if (!batchId) return null;
  if (exams.isPending) return <Loading label="Loading exams…" />;
  if (exams.isError) {
    return (
      <ErrorState
        title="Could not load the exams"
        message={errorMessage(exams.error)}
        onRetry={() => void exams.refetch()}
      />
    );
  }

  const choices = exams.data.filter((exam) => statuses.includes(exam.status));
  if (choices.length === 0)
    return <EmptyState title="No exams to choose from">{emptyHint}</EmptyState>;

  return (
    <Field label="Exam">
      {(id) => (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose an exam…</option>
          {choices.map((exam) => (
            <option key={exam.examId} value={exam.examId}>
              {exam.title} · {exam.date}
              {exam.status === 'PUBLISHED' ? ' (results published)' : ''}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
