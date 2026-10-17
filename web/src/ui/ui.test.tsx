import { useMutation, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { QueryProvider } from '../query/QueryProvider.js';
import { shouldRetry } from '../query/queryClient.js';
import { EmptyState, ErrorState, Loading } from './states.js';
import { ToastProvider } from './Toaster.js';

function Failing({ silent = false }: { silent?: boolean }) {
  useQuery({
    queryKey: ['failing', silent],
    queryFn: async () => {
      throw new ApiError(500, 'INTERNAL_ERROR', 'The server fell over');
    },
    retry: false,
    meta: { errorToast: !silent },
  });
  return null;
}

function FailingMutation() {
  const mutation = useMutation({
    mutationFn: async () => {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Name is required');
    },
  });
  return (
    <button type="button" onClick={() => mutation.mutate()}>
      Save
    </button>
  );
}

const wrap = (children: React.ReactNode) =>
  render(
    <ToastProvider>
      <QueryProvider>{children}</QueryProvider>
    </ToastProvider>,
  );

describe('toasts', () => {
  it('announces a failed query', async () => {
    wrap(<Failing />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The server fell over');
  });

  it('stays quiet when the screen shows the failure itself', async () => {
    wrap(<Failing silent />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces a failed mutation and can be dismissed', async () => {
    wrap(<FailingMutation />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name is required');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('shouldRetry', () => {
  it('retries server and network errors twice, but not client errors', () => {
    expect(shouldRetry(0, new ApiError(500, 'X', 'x'))).toBe(true);
    expect(shouldRetry(1, new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(true);
    expect(shouldRetry(2, new ApiError(500, 'X', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, 'FORBIDDEN', 'x'))).toBe(false);
  });
});

describe('states', () => {
  it('shows a loading status', () => {
    render(<Loading label="Loading exams…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading exams…');
  });

  it('shows an empty state with its explanation', () => {
    render(<EmptyState title="No exams yet">Published exams appear here.</EmptyState>);
    expect(screen.getByRole('heading', { name: 'No exams yet' })).toBeInTheDocument();
    expect(screen.getByText('Published exams appear here.')).toBeInTheDocument();
  });

  it('shows an error with a retry button only when it can retry', async () => {
    const retry = vi.fn();
    const { rerender } = render(<ErrorState message="Broke" onRetry={retry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Broke');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<ErrorState message="Broke" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
