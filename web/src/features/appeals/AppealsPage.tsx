import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AppealStatus, AppealSummary } from '@yulove/shared';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { useAppeals } from '../common/hooks.js';
import { APPEAL_STATUS_LABEL, APPEAL_STATUS_TONE, plural } from '../common/labels.js';
import { BatchSelect, ExamSelect } from '../common/pickers.js';
import { Chip, PageHeader } from '../common/ui.js';

type Filter = 'ALL' | AppealStatus;

/** Open appeals first; inside each group the newest first. */
export function orderAppeals(appeals: readonly AppealSummary[]): AppealSummary[] {
  const rank = (a: AppealSummary) => (a.status === 'OPEN' ? 0 : 1);
  return [...appeals].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
}

const snippet = (text: string) => (text.length > 110 ? `${text.slice(0, 107)}…` : text);

/**
 * The queue of appeals for one exam, for the teachers who handle them: any teacher of the batch
 * (or a super admin) can open the published exams of that batch.
 */
export function AppealsPage() {
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch') ?? '';
  const examId = params.get('exam') ?? '';
  const [filter, setFilter] = useState<Filter>('ALL');
  const appeals = useAppeals(examId || undefined);

  const select = (patch: Record<string, string>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  const shown = useMemo(
    () => orderAppeals(appeals.data ?? []).filter((a) => filter === 'ALL' || a.status === filter),
    [appeals.data, filter],
  );
  const count = (status: AppealStatus) =>
    (appeals.data ?? []).filter((a) => a.status === status).length;

  return (
    <section className="page">
      <PageHeader
        title="Appeals"
        intro="Students can appeal a question after results are published. Open appeals are shown first."
        backTo="/teacher"
      />

      <div className="form">
        <BatchSelect
          value={batchId}
          onChange={(id) => select({ batch: id, ...(id === batchId ? {} : { exam: '' }) })}
        />
        <ExamSelect
          batchId={batchId}
          value={examId}
          onChange={(id) => select({ exam: id })}
          statuses={['PUBLISHED']}
          emptyHint="No exam in this batch has been published yet, so there are no appeals."
        />
      </div>

      {examId ? (
        appeals.isPending ? (
          <Loading label="Loading the appeals…" />
        ) : appeals.isError ? (
          <ErrorState
            title="Could not load the appeals"
            message={errorMessage(appeals.error)}
            onRetry={() => void appeals.refetch()}
          />
        ) : (
          <div>
            <p>
              <strong>{plural(count('OPEN'), 'open appeal')}</strong> · {count('RERUN')} graded
              again · {count('CLOSED')} closed
            </p>
            <div className="toolbar">
              <button
                type="button"
                className="button"
                disabled={appeals.isFetching}
                onClick={() => void appeals.refetch()}
              >
                {appeals.isFetching ? 'Refreshing…' : 'Refresh'}
              </button>
              <div className="field inline">
                <label htmlFor="appeal-filter">Show</label>
                <select
                  id="appeal-filter"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as Filter)}
                >
                  <option value="ALL">All appeals (open first)</option>
                  <option value="OPEN">Open</option>
                  <option value="RERUN">Graded again</option>
                  <option value="CLOSED">Closed</option>
                </select>
              </div>
            </div>

            {shown.length === 0 ? (
              <EmptyState title="No appeals">
                {appeals.data.length === 0
                  ? 'Nobody has appealed anything in this exam.'
                  : 'No appeal matches this filter.'}
              </EmptyState>
            ) : (
              <ul className="cards cards-single" aria-label="Appeals">
                {shown.map((appeal) => (
                  <li key={appeal.appealId} className="card-item">
                    <div className="card-head">
                      <span className="row-title">
                        {appeal.rollNo ? `${appeal.rollNo} · ` : ''}
                        {appeal.studentName ?? appeal.studentEmail} · Question{' '}
                        {appeal.questionNumber}
                      </span>
                      <Chip tone={APPEAL_STATUS_TONE[appeal.status]}>
                        {APPEAL_STATUS_LABEL[appeal.status]}
                      </Chip>
                    </div>
                    <p className="muted break">“{snippet(appeal.message)}”</p>
                    <p className="muted">{new Date(appeal.createdAt).toLocaleString()}</p>
                    <Link
                      to={`/teacher/appeals/${encodeURIComponent(appeal.examId)}/${encodeURIComponent(
                        appeal.appealId,
                      )}?batch=${encodeURIComponent(batchId)}`}
                      className="button link-button"
                      aria-label={`Open the appeal from ${appeal.studentName ?? appeal.studentEmail} on question ${appeal.questionNumber}`}
                    >
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      ) : null}
    </section>
  );
}
