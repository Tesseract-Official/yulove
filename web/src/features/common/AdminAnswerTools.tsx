import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AnswerDetailResponse, AuditEntry } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { ApiError, errorMessage } from '../../api/errors.js';
import { useCurrentUser } from '../../session/MeContext.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { keys } from './hooks.js';
import { Field, Notice } from './ui.js';

const REASON_MAX = 1000;

/** A score typed as text, or undefined when it is not a number. */
function parseScore(text: string): number | undefined {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Checks the dialog's answers. Gives the request body, or what to fix. */
export function validateOverride(input: {
  mode: 'set' | 'clear';
  score: string;
  reason: string;
  marks: number;
}):
  | { ok: true; body: { score: number | null; reason: string } }
  | { ok: false; errors: { score?: string; reason?: string } } {
  const errors: { score?: string; reason?: string } = {};
  const reason = input.reason.trim();
  if (reason === '') errors.reason = 'Write why the score is being changed.';
  else if (reason.length > REASON_MAX) {
    errors.reason = `The reason is too long (${REASON_MAX} characters at most).`;
  }

  let score: number | null = null;
  if (input.mode === 'set') {
    const value = parseScore(input.score);
    if (value === undefined) errors.score = 'Type the new score as a number, for example 7.5.';
    else if (value < 0 || value > input.marks) {
      errors.score = `The score must be from 0 to ${input.marks}, the marks for this question.`;
    } else score = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { score, reason } };
}

function OverrideDialog({
  answer,
  onClose,
  onDone,
}: {
  answer: AnswerDetailResponse;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const hasOverride = answer.override !== undefined;
  const [mode, setMode] = useState<'set' | 'clear'>('set');
  const [score, setScore] = useState(String(answer.score));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ score?: string; reason?: string }>({});
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: (body: { score: number | null; reason: string }) =>
      api.setOverride(answer.examId, answer.studentEmail, answer.questionNumber, body),
    meta: { errorToast: false },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.answer(answer.examId, answer.studentEmail, answer.questionNumber),
        }),
        queryClient.invalidateQueries({
          queryKey: keys.audit(answer.examId, answer.studentEmail, answer.questionNumber),
        }),
        queryClient.invalidateQueries({ queryKey: keys.board(answer.examId) }),
        queryClient.invalidateQueries({ queryKey: keys.results(answer.examId) }),
      ]);
      onDone(
        result.override
          ? `The score is now ${result.score} out of ${answer.marks}.`
          : `The override was removed. The score is ${result.score} out of ${answer.marks}.`,
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateOverride({ mode, score, reason, marks: answer.marks });
    if (!result.ok) return setErrors(result.errors);
    setErrors({});
    save.mutate(result.body);
  };

  const absent = save.error instanceof ApiError && save.error.status === 409;

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="override-title">
        <h2 id="override-title">Override score</h2>
        <p className="muted">
          Question {answer.questionNumber} is worth {answer.marks} marks. The change is recorded in
          the audit history, and the student is told the score was adjusted by an admin.
        </p>
        {answer.override ? (
          <Notice kind="info">
            Current override: {answer.override.score} (by {answer.override.by}):{' '}
            {answer.override.reason}
          </Notice>
        ) : null}

        <form className="form" onSubmit={submit} noValidate>
          <fieldset className="shapes">
            <legend>What to do</legend>
            <label className="check">
              <input
                type="radio"
                name="override-mode"
                checked={mode === 'set'}
                onChange={() => setMode('set')}
              />
              <span>Set a score</span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="override-mode"
                checked={mode === 'clear'}
                disabled={!hasOverride}
                onChange={() => setMode('clear')}
              />
              <span>Remove the override and use the calculated score</span>
            </label>
          </fieldset>

          {mode === 'set' ? (
            <Field label={`New score (0 to ${answer.marks})`} error={errors.score}>
              {(id, aria) => (
                <input
                  id={id}
                  {...aria}
                  ref={first}
                  inputMode="decimal"
                  value={score}
                  onChange={(e) => setScore(e.target.value)}
                />
              )}
            </Field>
          ) : null}

          <Field
            label="Reason"
            hint="Needed for every change. It is kept in the audit history."
            error={errors.reason}
          >
            {(id, aria) => (
              <textarea
                id={id}
                {...aria}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>

          {save.isError ? (
            <Notice kind="error">
              {errorMessage(save.error)}
              {absent
                ? ' Mark the student present on the Upload answers screen first, then try again.'
                : ''}
            </Notice>
          ) : null}

          <div className="actions">
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : mode === 'clear' ? 'Remove override' : 'Save score'}
            </button>
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const ACTION_TEXT: Record<string, string> = {
  OVERRIDE_SCORE: 'Set an override',
  CLEAR_OVERRIDE: 'Removed the override',
};

const scoreOf = (state: unknown, key: 'displayedScore' | 'override'): number | null | undefined => {
  const value = (state as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'number' ? value : value === null ? null : undefined;
};

function AuditRow({ entry }: { entry: AuditEntry }) {
  const before = scoreOf(entry.before, 'displayedScore');
  const after = scoreOf(entry.after, 'displayedScore');
  return (
    <li className="row">
      <span className="row-title">{ACTION_TEXT[entry.action] ?? entry.action}</span>
      <span>
        Score {before ?? '?'} → {after ?? '?'}
      </span>
      <span className="muted break">
        By {entry.actor} · {new Date(entry.timestamp).toLocaleString()}
      </span>
      <span>Reason: {entry.reason}</span>
    </li>
  );
}

function AuditPanel({ answer }: { answer: AnswerDetailResponse }) {
  const api = useApi();
  const history = useQuery({
    queryKey: keys.audit(answer.examId, answer.studentEmail, answer.questionNumber),
    queryFn: () => api.getAnswerAudit(answer.examId, answer.studentEmail, answer.questionNumber),
    meta: { errorToast: false },
  });

  if (history.isPending) return <Loading label="Loading the history…" />;
  if (history.isError) {
    return (
      <ErrorState
        title="Could not load the history"
        message={errorMessage(history.error)}
        onRetry={() => void history.refetch()}
      />
    );
  }
  const entries = [...history.data.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (entries.length === 0) {
    return <EmptyState title="No changes">No changes have been made to this score.</EmptyState>;
  }
  return (
    <ul className="rows" aria-label="Audit history">
      {entries.map((entry) => (
        <AuditRow key={`${entry.timestamp}-${entry.action}`} entry={entry} />
      ))}
    </ul>
  );
}

/**
 * For super admins only, on an answer: change the score by hand, and see who changed it before.
 * Everyone else sees nothing here, and these routes are never called for them.
 */
export function AdminAnswerTools({ answer }: { answer: AnswerDetailResponse }) {
  const me = useCurrentUser();
  const [dialog, setDialog] = useState(false);
  const [history, setHistory] = useState(false);
  const [done, setDone] = useState<string | undefined>();

  if (me.role !== 'SUPER_ADMIN') return null;

  return (
    <section className="admin-tools" aria-label="Admin tools">
      <h2>Admin tools</h2>
      {done ? <Notice kind="success">{done}</Notice> : null}
      <div className="actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            setDone(undefined);
            setDialog(true);
          }}
        >
          Override score
        </button>
        <button
          type="button"
          className="button"
          aria-expanded={history}
          onClick={() => setHistory((open) => !open)}
        >
          Audit history
        </button>
      </div>
      {history ? <AuditPanel answer={answer} /> : null}
      {dialog ? (
        <OverrideDialog
          answer={answer}
          onClose={() => setDialog(false)}
          onDone={(message) => {
            setDialog(false);
            setDone(message);
          }}
        />
      ) : null}
    </section>
  );
}
