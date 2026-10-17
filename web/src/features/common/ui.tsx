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

/** A label and its control (the child is rendered with the label tied to it). */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children(id)}
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
