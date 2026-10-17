import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ExamBoardResponse } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { ApiError, errorMessage } from '../../api/errors.js';
import { keys } from '../common/hooks.js';
import { plural } from '../common/labels.js';
import { Chip, Notice } from '../common/ui.js';

/** How many answers the API says are still being graded, if its 409 says so. */
export function inProgressFrom(error: unknown): number | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const count = (error.details as { inProgress?: unknown } | undefined)?.inProgress;
  return typeof count === 'number' ? count : undefined;
}

/**
 * Publishing makes the results visible to students. If answers are still being graded the API says
 * how many, and the person has to confirm before the request is sent again with `confirm: true`.
 */
export function PublishBar({ board }: { board: ExamBoardResponse }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [waiting, setWaiting] = useState<number | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  const publish = useMutation({
    mutationFn: (confirm: boolean) => api.publishExam(board.examId, confirm),
    meta: { errorToast: false },
    onSuccess: async () => {
      setWaiting(undefined);
      setProblem(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.board(board.examId) }),
        queryClient.invalidateQueries({ queryKey: ['exams'] }),
      ]);
    },
    onError: (error) => {
      const count = inProgressFrom(error);
      if (count !== undefined) {
        setWaiting(count);
        setProblem(undefined);
      } else {
        setWaiting(undefined);
        setProblem(errorMessage(error));
      }
    },
  });

  if (board.examStatus === 'PUBLISHED') {
    return (
      <p>
        <Chip tone="good">Results published</Chip> Students can see their results.
      </p>
    );
  }
  if (board.examStatus !== 'READY') {
    return <Notice kind="info">This exam is not ready yet, so it cannot be published.</Notice>;
  }

  return (
    <div className="publish">
      {waiting !== undefined ? (
        <div className="confirm" role="alertdialog" aria-label="Publish anyway?">
          <p>
            <strong>
              {plural(waiting, 'answer')} {waiting === 1 ? 'is' : 'are'} still being graded.
            </strong>{' '}
            If you publish now, students will see {waiting === 1 ? 'it' : 'them'} as “still being
            graded” until {waiting === 1 ? 'it finishes' : 'they finish'}. Publish anyway?
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={publish.isPending}
              onClick={() => publish.mutate(true)}
            >
              {publish.isPending ? 'Publishing…' : 'Publish anyway'}
            </button>
            <button type="button" className="button" onClick={() => setWaiting(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="button button-primary"
          disabled={publish.isPending}
          onClick={() => publish.mutate(false)}
        >
          {publish.isPending ? 'Publishing…' : 'Publish results'}
        </button>
      )}
      {problem ? <Notice kind="error">{problem}</Notice> : null}
    </div>
  );
}
