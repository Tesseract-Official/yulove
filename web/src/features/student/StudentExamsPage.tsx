import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { keys } from '../common/hooks.js';
import { Chip } from '../common/ui.js';

/** Student: the exams whose results have been published, with the student's total for each. */
export function StudentExamsPage() {
  const api = useApi();
  const exams = useQuery({
    queryKey: keys.myExams,
    queryFn: async () => (await api.getMyExams()).exams,
    meta: { errorToast: false },
  });

  return (
    <section className="page">
      <h1>Your results</h1>
      <p className="muted">These are the exams whose results have been published.</p>

      {exams.isPending ? (
        <Loading label="Loading your results…" />
      ) : exams.isError ? (
        <ErrorState
          title="Could not load your results"
          message={errorMessage(exams.error)}
          onRetry={() => void exams.refetch()}
        />
      ) : exams.data.length === 0 ? (
        <EmptyState title="Nothing published yet">
          No results have been published yet. They will appear here when your batch manager
          publishes them.
        </EmptyState>
      ) : (
        <ul className="cards cards-single">
          {exams.data.map((exam) => (
            <li key={exam.examId} className="card-item">
              <div className="card-head">
                <span className="row-title">{exam.title}</span>
                {exam.absent ? (
                  <Chip tone="bad">Absent</Chip>
                ) : (
                  <span className="score">
                    {exam.totalScore} / {exam.maxScore}
                  </span>
                )}
              </div>
              <p className="muted">{exam.date}</p>
              <Link to={`/student/exams/${exam.examId}`} className="button link-button">
                See my marks
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
