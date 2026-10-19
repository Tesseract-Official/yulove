import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../../api/ApiContext.js';
import { ApiError, errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { keys } from '../common/hooks.js';
import { ScoreTools } from '../common/ScoreTools.js';
import { AnswerDetail } from '../common/AnswerDetail.js';
import { Notice, PageHeader } from '../common/ui.js';

/** Batch manager: one answer in full: the photo, what was read from it, and how each test went. */
export function AnswerPage({ section = 'manager' }: { section?: 'manager' | 'teacher' }) {
  const { examId = '', email = '', q = '' } = useParams();
  const [params] = useSearchParams();
  const question = Number(q);
  const api = useApi();
  const queryClient = useQueryClient();

  const batch = params.get('batch');
  const backTo = `/${section}/${section === 'teacher' ? 'results' : 'board'}?exam=${encodeURIComponent(examId)}${
    batch ? `&batch=${encodeURIComponent(batch)}` : ''
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
      backLabel={section === 'teacher' ? 'Back to the results' : 'Back to the board'}
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

  return (
    <section className="page">
      {header}

      {a.status === 'FAILED_TO_GRADE' ? (
        <div className="form">
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

      <AnswerDetail answer={a} />
      <ScoreTools answer={a} />
    </section>
  );
}
