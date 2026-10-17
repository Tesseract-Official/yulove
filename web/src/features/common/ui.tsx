import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CellStatus } from '@yulove/shared';
import { STATUS_LABEL, STATUS_TONE, type Tone } from './labels.js';

/** A coloured word: the status of an answer, or any short label. */
export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function StatusChip({ status }: { status: CellStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Chip>;
}

/** A message box. `error` is announced to screen readers straight away. */
export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success' | 'warning';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="back-link">
      ← {children}
    </Link>
  );
}

/** What a control needs to be tied to its error message. */
export interface FieldAria {
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

/**
 * A label and its control (the child is rendered with the label tied to it), an optional hint and
 * an optional error message, which is announced with the control.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (id: string, aria: FieldAria) => ReactNode;
}) {
  const id = useId();
  const described = [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  const aria: FieldAria = {
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(described ? { 'aria-describedby': described } : {}),
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children(id, aria)}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A page: a title and a way back to the section menu. */
export function PageHeader({
  title,
  intro,
  backTo,
  backLabel = 'Back to menu',
}: {
  title: string;
  intro?: string;
  backTo: string;
  backLabel?: string;
}) {
  return (
    <header className="page-header">
      <BackLink to={backTo}>{backLabel}</BackLink>
      <h1>{title}</h1>
      {intro ? <p className="muted">{intro}</p> : null}
    </header>
  );
}

/** A big tappable card that links to a screen. */
export function MenuCard({
  to,
  title,
  children,
}: {
  to: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="menu-card">
      <span className="menu-card-title">{title}</span>
      <span className="muted">{children}</span>
    </Link>
  );
}
