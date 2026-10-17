import { Link } from 'react-router-dom';
import { errorMessage } from '../../api/errors.js';
import { useCurrentUser } from '../../session/MeContext.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { useAllExams, useBatches } from '../common/hooks.js';
import { EXAM_STATUS_LABEL, EXAM_STATUS_TONE, plural } from '../common/labels.js';
import { Chip, PageHeader } from '../common/ui.js';

/** Teacher: the exams of the batches they teach. */
export function ExamsPage() {
  const me = useCurrentUser();
  const exams = useAllExams();
  const batches = useBatches();
  const batchName = (id: string) => batches.data?.find((b) => b.batchId === id)?.name ?? id;

  return (
    <section className="page">
      <PageHeader title="Exams" backTo="/teacher" />
      <p>
        <Link to="/teacher/exams/new" className="button button-primary link-button">
          Build a new exam
        </Link>
      </p>

      {exams.isPending ? (
        <Loading label="Loading the exams…" />
      ) : exams.isError ? (
        <ErrorState
          title="Could not load the exams"
          message={errorMessage(exams.error)}
          onRetry={() => void exams.refetch()}
        />
      ) : exams.data.length === 0 ? (
        <EmptyState title="No exams yet">
          Build an exam from your approved questions. You need at least one approved question first.
        </EmptyState>
      ) : (
        <ul className="cards">
          {exams.data.map((exam) => (
            <li key={exam.examId} className="card-item">
              <div className="card-head">
                <span className="row-title">{exam.title}</span>
                <Chip tone={EXAM_STATUS_TONE[exam.status]}>{EXAM_STATUS_LABEL[exam.status]}</Chip>
              </div>
              <p className="muted">
                {batchName(exam.batchId)} · {exam.date} · {plural(exam.questionCount, 'question')}
              </p>
              {exam.createdBy !== me.email ? (
                <p className="muted break">Made by {exam.createdBy}</p>
              ) : null}
              <div className="actions">
                <Link to={`/teacher/exams/${exam.examId}`} className="button link-button">
                  Open
                </Link>
                {exam.status !== 'DRAFT' ? (
                  <Link
                    to={`/teacher/results?batch=${encodeURIComponent(exam.batchId)}&exam=${encodeURIComponent(exam.examId)}`}
                    className="button link-button"
                  >
                    Results
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
