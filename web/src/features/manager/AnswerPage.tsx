import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/ApiContext.js';
import { ApiError, errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { keys } from '../common/hooks.js';
import { FAIL_REASON_TEXT, LANGUAGE_TEXT, VERDICT_TEXT } from '../common/labels.js';
import { Chip, Notice, PageHeader, StatusChip } from '../common/ui.js';

/** Batch manager: one answer in full: the photo, what was read from it, and how each test went. */
export function AnswerPage() {
  const { examId = '', email = '', q = '' } = useParams();
  const [params] = useSearchParams();
  const question = Number(q);
  const api = useApi();
  const queryClient = useQueryClient();

  const backTo = `/manager/board?exam=${encodeURIComponent(examId)}${
    params.get('batch') ? `&batch=${encodeURIComponent(params.get('batch') ?? '')}` : ''
  }`;

  const answer = useQuery({
    queryKey: keys.answer(examId, email, question),
    queryFn: () => api.getAnswer(examId, email, question),
    meta: { errorToast: false },
    retry: false,
  });

  const rerun = useMutation({
    mutationFn: () => api.rerunAnswer(examId, email, question),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.board(examId) }),
        queryClient.invalidateQueries({ queryKey: keys.answer(examId, email, question) }),
      ]);
    },
  });

  const header = (
    <PageHeader
      title={`Question ${q}`}
      intro={email}
      backTo={backTo}
      backLabel="Back to the board"
    />
  );

  if (answer.isPending)
    return (
      <section className="page">
        {header}
        <Loading label="Loading the answer…" />
      </section>
    );
  if (answer.isError) {
    const none = answer.error instanceof ApiError && answer.error.status === 404;
    return (
      <section className="page">
        {header}
        {none ? (
          <EmptyState title="No photo yet">
            No answer has been uploaded for this question yet.
          </EmptyState>
        ) : (
          <ErrorState
            title="Could not load the answer"
            message={errorMessage(answer.error)}
            onRetry={() => void answer.refetch()}
          />
        )}
      </section>
    );
  }

  const a = answer.data;
  const minutes = a.imageExpiresInSeconds ? Math.round(a.imageExpiresInSeconds / 60) : undefined;

  return (
    <section className="page">
      {header}

      <div className="answer-summary">
        <StatusChip status={a.status} />
        {a.absent ? <Chip tone="bad">Absent</Chip> : null}
        <span className="score">
          {a.score} / {a.marks} marks
        </span>
      </div>

      {a.status === 'FAILED_TO_GRADE' ? (
        <div className="form">
          <Notice kind="error">
            {a.failReason ? FAIL_REASON_TEXT[a.failReason] : 'This answer could not be graded.'}
            {a.failDetail ? ` ${a.failDetail}` : ''}
          </Notice>
          {rerun.isSuccess ? (
            <Notice kind="success">
              Sent for grading again. Press Refresh on the board to see it.
            </Notice>
          ) : (
            <button
              type="button"
              className="button button-primary"
              disabled={rerun.isPending}
              onClick={() => rerun.mutate()}
            >
              {rerun.isPending ? 'Sending…' : 'Grade again'}
            </button>
          )}
        </div>
      ) : null}

      <h2>The photo</h2>
      {a.imageUrl ? (
        <>
          <img className="answer-photo" src={a.imageUrl} alt={`Answer photo for question ${q}`} />
          {minutes ? (
            <p className="muted">
              This photo link works for about {minutes} minutes. Reload the page to get a new one.
            </p>
          ) : null}
        </>
      ) : (
        <p className="muted">No photo is stored for this answer.</p>
      )}

      <h2>What was read from the photo</h2>
      <dl className="facts">
        {a.language ? (
          <>
            <dt>Language</dt>
            <dd>{LANGUAGE_TEXT[a.language]}</dd>
          </>
        ) : null}
        {a.estimatedComplexity ? (
          <>
            <dt>Estimated speed</dt>
            <dd>
              {a.estimatedComplexity}
              {a.meetsComplexity === false ? ' (slower than the required speed)' : ''}
            </dd>
          </>
        ) : null}
        {a.testsTotal !== undefined ? (
          <>
            <dt>Tests passed</dt>
            <dd>
              {a.testsPassed ?? 0} of {a.testsTotal}
            </dd>
          </>
        ) : null}
      </dl>

      {a.rawTranscription !== undefined ? (
        <>
          <h3>As written</h3>
          <pre className="code" tabIndex={0}>
            {a.rawTranscription}
          </pre>
        </>
      ) : null}
      {a.correctedCode !== undefined ? (
        <>
          <h3>After fixing typing mistakes</h3>
          <pre className="code" tabIndex={0}>
            {a.correctedCode}
          </pre>
        </>
      ) : null}
      {a.fixes.length > 0 ? (
        <>
          <h3>Fixes that were made</h3>
          <ul className="list">
            {a.fixes.map((fix, index) => (
              <li key={`${index}-${fix}`}>{fix}</li>
            ))}
          </ul>
        </>
      ) : null}

      {a.verdicts.length > 0 ? (
        <>
          <h2>Test results</h2>
          <ul className="rows" aria-label="Test results">
            {a.verdicts.map((v) => (
              <li key={v.index} className="row">
                <span className="row-title">
                  Test {v.index + 1} ({v.kind === 'large' ? 'large' : 'small'}){' '}
                  <Chip tone={v.verdict === 'AC' ? 'good' : 'bad'}>{VERDICT_TEXT[v.verdict]}</Chip>
                </span>
                {v.input !== undefined ? (
                  <details>
                    <summary>Show what was tried</summary>
                    <p className="muted">Input</p>
                    <pre className="code">{v.input}</pre>
                    <p className="muted">Expected</p>
                    <pre className="code">{v.expected}</pre>
                    <p className="muted">The program printed</p>
                    <pre className="code">{v.actual}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
