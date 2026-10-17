import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  notify(message: string, kind?: ToastKind): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_MS = 6_000;

/** Short messages in the corner of the screen. Failures are announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = 'error') => {
      const id = nextId.current++;
      // The same message twice in a row (a retry that fails again) is shown once.
      setToasts((current) =>
        current.some((toast) => toast.message === message)
          ? current
          : [...current.slice(-2), { id, kind, message }],
      );
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <span>{toast.message}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)}>
              <span className="sr-only">Dismiss</span>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
