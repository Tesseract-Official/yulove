import type { ReactNode } from 'react';

/** Shown while something loads. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

/** Shown when a list or page has nothing to show yet. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** Shown when loading failed, with a way to try again. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state state-error" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
