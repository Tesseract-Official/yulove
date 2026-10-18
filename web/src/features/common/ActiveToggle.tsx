import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { INACTIVE_LABEL } from './labels.js';
import { Field, Notice } from './ui.js';

export const REASON_MAX = 1000;

/** Someone who can be switched off. */
export interface Person {
  email: string;
  name: string;
  active: boolean;
}

/** Checks what was typed. Gives the reason to send, or what to fix. */
export function validateReason(
  text: string,
): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = text.trim();
  if (reason === '') return { ok: false, error: 'Write why, so there is a record of it.' };
  if (reason.length > REASON_MAX) {
    return { ok: false, error: `The reason is too long (${REASON_MAX} characters at most).` };
  }
  return { ok: true, reason };
}

function ReasonDialog({
  person,
  onClose,
  onDone,
}: {
  person: Person;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const api = useApi();
  const turningOff = person.active;
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const first = useRef<HTMLTextAreaElement>(null);

  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: (text: string) =>
      api.setUserActive(person.email, { active: !person.active, reason: text }),
    meta: { errorToast: false },
    onSuccess: (result) =>
      onDone(
        result.user.active
          ? `${person.name} is active again.`
          : `${person.name} is now inactive and cannot sign in or use the app.`,
      ),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = validateReason(reason);
    if (!checked.ok) return setError(checked.error);
    setError(undefined);
    save.mutate(checked.reason);
  };

  const title = turningOff ? `Make ${person.name} inactive` : `Make ${person.name} active again`;

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="active-title">
        <h2 id="active-title">{title}</h2>
        <p className="muted">
          {turningOff
            ? 'They will be refused everywhere in the app from now on, but nothing about them is deleted. You can make them active again at any time.'
            : 'They will be able to sign in and use the app again.'}{' '}
          Your reason is kept in the audit log.
        </p>
        <form className="form" onSubmit={submit} noValidate>
          <Field label="Reason" error={error}>
            {(id, aria) => (
              <textarea
                id={id}
                {...aria}
                ref={first}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
          <div className="actions">
            <button
              type="submit"
              className={`button ${turningOff ? 'button-danger' : 'button-primary'}`}
              disabled={save.isPending}
            >
              {save.isPending ? 'Saving…' : turningOff ? 'Make inactive' : 'Make active'}
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

/**
 * An Active / Inactive switch. Pressing it asks for a reason first; nothing is sent until the
 * reason is given. `onChanged` runs after the change went through, so the screen can reload.
 */
export function ActiveToggle({
  person,
  onChanged,
}: {
  person: Person;
  onChanged: () => Promise<unknown> | void;
}) {
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<string | undefined>();
  const word = person.active ? 'Active' : INACTIVE_LABEL;

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={person.active}
        aria-label={`${word}: ${person.name}`}
        className={`switch ${person.active ? 'switch-on' : 'switch-off'}`}
        onClick={() => {
          setDone(undefined);
          setAsking(true);
        }}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span>{word}</span>
      </button>
      {done ? (
        <span className="muted" role="status">
          {done}
        </span>
      ) : null}
      {asking ? (
        <ReasonDialog
          person={person}
          onClose={() => setAsking(false)}
          onDone={(message) => {
            setAsking(false);
            setDone(message);
            void onChanged();
          }}
        />
      ) : null}
    </>
  );
}
