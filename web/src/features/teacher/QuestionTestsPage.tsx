import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { testFailureText, type Signature, type TestPreview } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { ErrorState, Loading } from '../../ui/states.js';
import { keys, useQuestion, useQuestionTests } from '../common/hooks.js';
import { TEST_STATE_LABEL, TEST_STATE_TONE, type TestState } from '../common/labels.js';
import { Chip, Notice, PageHeader } from '../common/ui.js';

/** Short one-line values are shown as they are; long ones are folded away. */
const INLINE_MAX = 120;

function ValueBlock({ label, value }: { label: string; value: string }) {
  if (value.length <= INLINE_MAX && !value.includes('\n')) {
    return (
      <div>
        <p className="muted">{label}</p>
        <pre className="code">{value}</pre>
      </div>
    );
  }
  return (
    <details>
      <summary>
        {label} ({value.length.toLocaleString('en')} characters)
      </summary>
      <pre className="code" tabIndex={0}>
        {value}
      </pre>
    </details>
  );
}

function TestCard({ test }: { test: TestPreview }) {
  return (
    <li className="card-item test-card">
      <div className="card-head">
        <span className="row-title">Test {test.index + 1}</span>
        {test.kind === 'large' ? <Chip tone="progress">Large test</Chip> : <Chip>Small test</Chip>}
        {test.truncated ? <Chip tone="bad">Shortened</Chip> : null}
      </div>
      <ValueBlock label="Input" value={test.input} />
      <ValueBlock label="Expected output" value={test.expected} />
      {test.truncated ? (
        <p className="muted">
          Only the first 1,000 characters are shown here. The full test is used for grading.
        </p>
      ) : null}
    </li>
  );
}

/** `twoSum(nums: int[], target: int) → int[]` */
export function describeSignature(signature: Signature): string {
  const params = signature.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
  return `${signature.name}(${params}) → ${signature.returnType}`;
}

/** Why Approve is not available, for each state where it is not. */
const APPROVE_REASON: Record<TestState, string> = {
  NONE: 'Generate the tests first.',
  GENERATING: 'Available when the tests are ready for review.',
  NEEDS_REVIEW: '',
  APPROVED: 'These tests are already approved.',
  GENERATION_FAILED: 'Generate the tests again first.',
};

/**
 * Teacher: make a question's tests, check them and approve them. Nothing updates by itself: the
 * Refresh button asks again.
 */
export function QuestionTestsPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const location = useLocation();
  const arrivedWith = (location.state as { notice?: string } | null)?.notice;

  const question = useQuestion(id);
  const tests = useQuestionTests(id);
  const [started, setStarted] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.question(id) }),
      queryClient.invalidateQueries({ queryKey: keys.questionTests(id) }),
      queryClient.invalidateQueries({ queryKey: keys.questions }),
    ]);

  const generate = useMutation({
    mutationFn: () => api.generateTests(id),
    meta: { errorToast: false },
    onSuccess: async () => {
      setStarted(true);
      setConfirming(false);
      await refresh();
    },
  });
  const approve = useMutation({
    mutationFn: () => api.approveQuestion(id),
    meta: { errorToast: false },
    onSuccess: refresh,
  });

  const header = (
    <PageHeader
      title={question.data ? `Tests for “${question.data.question.title}”` : 'Tests'}
      intro={question.data ? `Version ${question.data.question.version}` : undefined}
      backTo="/teacher/questions"
      backLabel="Back to the questions"
    />
  );

  if (question.isPending || tests.isPending) {
    return (
      <section className="page">
        {header}
        <Loading label="Loading the tests…" />
      </section>
    );
  }
  if (question.isError || tests.isError) {
    return (
      <section className="page">
        {header}
        <ErrorState
          title="Could not load the tests"
          message={errorMessage(question.error ?? tests.error)}
          onRetry={() => void refresh()}
        />
      </section>
    );
  }

  const state: TestState = tests.data.testStatus ?? 'NONE';
  const inUse = question.data.inUse;
  const checkedAt = new Date(Math.max(tests.dataUpdatedAt, question.dataUpdatedAt));
  const busy = generate.isPending || approve.isPending;
  const error = generate.error ?? approve.error;

  return (
    <section className="page">
      {header}

      {arrivedWith ? <Notice kind="success">{arrivedWith}</Notice> : null}

      <div className="status-line">
        <span>
          Status: <Chip tone={TEST_STATE_TONE[state]}>{TEST_STATE_LABEL[state]}</Chip>
        </span>
        <button
          type="button"
          className="button"
          disabled={tests.isFetching || question.isFetching}
          onClick={() => void refresh()}
        >
          {tests.isFetching || question.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        <span className="muted">Checked {checkedAt.toLocaleTimeString()}</span>
      </div>
      <p className="muted">This page does not update by itself. Press Refresh to check again.</p>

      {inUse ? (
        <Notice kind="warning">
          An exam that uses this version already has answers, so its tests cannot be changed.{' '}
          <Link to={`/teacher/questions/${id}`}>Edit the question</Link> to make a new version, then
          generate that version’s tests.
        </Notice>
      ) : null}

      {state === 'GENERATING' ? (
        <Notice kind="info">
          The tests are being made. The first generation can take a few minutes. Press Refresh to
          check.
        </Notice>
      ) : null}
      {started && state !== 'GENERATING' ? (
        <Notice kind="info">Generation started. Press Refresh in a minute or two to check.</Notice>
      ) : null}
      {state === 'GENERATION_FAILED' ? (
        <Notice kind="error">{testFailureText(tests.data.testFailure)}</Notice>
      ) : null}

      {state === 'NONE' || state === 'GENERATION_FAILED' ? (
        <p>
          {!inUse ? (
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => generate.mutate()}
            >
              {generate.isPending
                ? 'Starting…'
                : state === 'NONE'
                  ? 'Generate tests'
                  : 'Generate tests again'}
            </button>
          ) : null}
        </p>
      ) : null}

      {state === 'GENERATING' && !inUse ? (
        <p className="muted">
          Still on “Generating” after 15 minutes?{' '}
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={() => generate.mutate()}
          >
            Start again
          </button>
        </p>
      ) : null}

      {state === 'NEEDS_REVIEW' || state === 'APPROVED' ? (
        <>
          <h2>The function students write</h2>
          {tests.data.signature ? (
            <>
              <pre className="code">{describeSignature(tests.data.signature)}</pre>
              <p className="muted">
                Students are told to use this name and these inputs on the exam paper.
              </p>
            </>
          ) : (
            <p className="muted">No function signature has been made yet.</p>
          )}

          <h2>The 10 tests</h2>
          <p className="muted">
            The expected outputs come from running the reference solution, not from reading it.
            Check that they are right before you approve.
          </p>
          {tests.data.tests ? (
            <ul className="cards cards-single">
              {tests.data.tests.map((t) => (
                <TestCard key={t.index} test={t} />
              ))}
            </ul>
          ) : (
            <Notice kind="info">The tests are not available yet. Press Refresh.</Notice>
          )}
        </>
      ) : null}

      {error ? <Notice kind="error">{errorMessage(error)}</Notice> : null}

      <div className="review-actions">
        <div className="actions">
          <button
            type="button"
            className="button button-primary"
            disabled={state !== 'NEEDS_REVIEW' || busy}
            onClick={() => approve.mutate()}
          >
            {approve.isPending ? 'Approving…' : 'Approve'}
          </button>
          {(state === 'NEEDS_REVIEW' || state === 'APPROVED') && !inUse ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => (state === 'APPROVED' ? setConfirming(true) : generate.mutate())}
            >
              {generate.isPending ? 'Starting…' : 'Regenerate'}
            </button>
          ) : null}
        </div>
        {state !== 'NEEDS_REVIEW' ? <p className="muted">{APPROVE_REASON[state]}</p> : null}
      </div>

      {confirming ? (
        <div className="confirm" role="alertdialog" aria-label="Regenerate approved tests?">
          <p>
            These tests are approved. Regenerating throws them away: you will have to review and
            approve the new ones, and exams cannot use this question until you do.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => generate.mutate()}
            >
              Yes, regenerate
            </button>
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
