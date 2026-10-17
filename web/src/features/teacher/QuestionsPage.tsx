import { Link } from 'react-router-dom';
import { errorMessage } from '../../api/errors.js';
import { useCurrentUser } from '../../session/MeContext.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { useQuestions } from '../common/hooks.js';
import { TEST_STATE_LABEL, TEST_STATE_TONE, plural } from '../common/labels.js';
import { Chip, PageHeader } from '../common/ui.js';

/** Teacher: the questions they wrote, with the state of each one's tests. */
export function QuestionsPage() {
  const me = useCurrentUser();
  const questions = useQuestions();

  return (
    <section className="page">
      <PageHeader title="Questions" backTo="/teacher" />
      <p>
        <Link to="/teacher/questions/new" className="button button-primary link-button">
          Write a new question
        </Link>
      </p>

      {questions.isPending ? (
        <Loading label="Loading your questions…" />
      ) : questions.isError ? (
        <ErrorState
          title="Could not load the questions"
          message={errorMessage(questions.error)}
          onRetry={() => void questions.refetch()}
        />
      ) : questions.data.length === 0 ? (
        <EmptyState title="No questions yet">
          Write your first question. After that you can make its tests and approve them.
        </EmptyState>
      ) : (
        <ul className="cards">
          {questions.data.map((q) => {
            const state = q.testStatus ?? 'NONE';
            return (
              <li key={q.questionId} className="card-item">
                <div className="card-head">
                  <span className="row-title">{q.title}</span>
                  <Chip tone={TEST_STATE_TONE[state]}>{TEST_STATE_LABEL[state]}</Chip>
                </div>
                <p className="muted">
                  Version {q.version} · Time complexity {q.targetComplexity} ·{' '}
                  {q.usedInExams === 0
                    ? 'Not in any exam yet'
                    : `In ${plural(q.usedInExams, 'exam')}`}
                </p>
                {q.teacherEmail !== me.email ? (
                  <p className="muted break">Written by {q.teacherEmail}</p>
                ) : null}
                {q.testFailure ? <p className="muted">{q.testFailure}</p> : null}
                <div className="actions">
                  <Link to={`/teacher/questions/${q.questionId}`} className="button link-button">
                    Edit
                  </Link>
                  <Link
                    to={`/teacher/questions/${q.questionId}/tests`}
                    className="button link-button"
                  >
                    Tests
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
