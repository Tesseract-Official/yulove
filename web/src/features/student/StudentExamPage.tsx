import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  APPEAL_MESSAGE_MAX,
  MESSAGES,
  type FailedSmallTest,
  type StudentQuestionView,
} from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { ErrorState, Loading } from '../../ui/states.js';
import { keys } from '../common/hooks.js';
import { STUDENT_APPEAL_TEXT, STUDENT_VERDICT_TEXT } from '../common/labels.js';
import { Chip, Field, Notice, PageHeader } from '../common/ui.js';

/** Short one-line values are shown as they are; long ones are folded away. */
const INLINE_MAX = 80;

function Value({ label, value }: { label: string; value: string }) {
  if (value.length <= INLINE_MAX && !value.includes('\n')) {
    return (
      <div>
        <p className="muted">{label}</p>
        <pre className="code">{value}</pre>
      </div>
    );
  }
  return (
    <details>
      <summary>
        {label} ({value.length.toLocaleString('en')} characters)
      </summary>
      <pre className="code" tabIndex={0}>
        {value}
      </pre>
    </details>
  );
}

function FailedSmallTest({ test }: { test: FailedSmallTest }) {
  return (
    <li className="row">
      <span className="row-title">
        Test {test.index + 1}: {STUDENT_VERDICT_TEXT[test.verdict]}
      </span>
      {test.input !== undefined ? <Value label="Input" value={test.input} /> : null}
      {test.expected !== undefined ? <Value label="Expected output" value={test.expected} /> : null}
      {test.actual !== undefined ? <Value label="Your output" value={test.actual} /> : null}
    </li>
  );
}

/** One of the lines the API gives a question, as a message box of the right kind. */
function MessageLine({ text }: { text: string }) {
  const kind =
    text === MESSAGES.adjusted || text === MESSAGES.absent || text === MESSAGES.inProgress
      ? 'info'
      : 'warning';
  return <Notice kind={kind}>{text}</Notice>;
}

function AppealForm({ examId, questionNumber }: { examId: string; questionNumber: number }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  const send = useMutation({
    mutationFn: (text: string) => api.createAppeal({ examId, questionNumber, message: text }),
    meta: { errorToast: false },
    onSuccess: async () => {
      setOpen(false);
      setMessage('');
      setProblem(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.myExam(examId) }),
        queryClient.invalidateQueries({ queryKey: keys.myExams }),
      ]);
    },
    onError: (error) => {
      setProblem(errorMessage(error));
      // Someone may have opened an appeal in the meantime: show what is true now.
      void queryClient.invalidateQueries({ queryKey: keys.myExam(examId) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (text === '') return setProblem('Write a short message for the reviewer first.');
    if (text.length > APPEAL_MESSAGE_MAX) {
      return setProblem(`The message is too long (${APPEAL_MESSAGE_MAX} characters at most).`);
    }
    setProblem(undefined);
    send.mutate(text);
  };

  if (!open) {
    return (
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Raise an appeal
      </button>
    );
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field
        label={`Tell the reviewer what you think is wrong with question ${questionNumber}`}
        error={problem}
      >
        {(id, aria) => (
          <>
            <textarea
              id={id}
              {...aria}
              rows={4}
              maxLength={APPEAL_MESSAGE_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="muted counter" aria-live="polite">
              {message.length} / {APPEAL_MESSAGE_MAX}
            </p>
          </>
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send appeal'}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function QuestionCard({ examId, view }: { examId: string; view: StudentQuestionView }) {
  const appeal = view.appeal;
  return (
    <li className="card-item question-card">
      <div className="card-head">
        <h2>Question {view.number}</h2>
        {view.status === 'ABSENT' ? (
          <Chip tone="bad">Absent</Chip>
        ) : (
          <span className="score">
            {view.score} / {view.marks}
          </span>
        )}
      </div>

      {/* "Absent" is already the chip beside the title. */}
      {view.messages
        .filter((text) => text !== MESSAGES.absent)
        .map((text) => (
          <MessageLine key={text} text={text} />
        ))}

      {view.testsPassed !== undefined && view.testsTotal !== undefined ? (
        <p>
          <strong>
            {view.testsPassed} of {view.testsTotal} tests passed
          </strong>
        </p>
      ) : null}

      {view.failedSmallTests.length > 0 || view.failedLargeTests.length > 0 ? (
        <div>
          <h3>Tests that did not pass</h3>
          <ul className="rows" aria-label={`Tests that did not pass in question ${view.number}`}>
            {view.failedSmallTests.map((test) => (
              <FailedSmallTest key={test.index} test={test} />
            ))}
            {view.failedLargeTests.map((test) => (
              <li key={test.label} className="row">
                <span className="row-title">
                  {test.label}: {STUDENT_VERDICT_TEXT[test.verdict]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {appeal ? (
        <div className="appeal-box">
          <p>
            <strong>Your appeal:</strong> <Chip>{STUDENT_APPEAL_TEXT[appeal.status]}</Chip>
          </p>
          <p className="muted break">“{appeal.message}”</p>
          {appeal.note ? (
            <p>
              <strong>Reviewer’s note:</strong> {appeal.note}
            </p>
          ) : null}
        </div>
      ) : null}

      {view.canAppeal ? <AppealForm examId={examId} questionNumber={view.number} /> : null}
    </li>
  );
}

/** Student: one published exam: marks per question, what failed, and appeals. */
export function StudentExamPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const exam = useQuery({
    queryKey: keys.myExam(id),
    queryFn: () => api.getMyExam(id),
    meta: { errorToast: false },
    retry: false,
  });

  const header = (
    <PageHeader
      title={exam.data?.title ?? 'Your marks'}
      intro={exam.data?.date}
      backTo="/student"
      backLabel="Back to your results"
    />
  );

  if (exam.isPending) {
    return (
      <section className="page">
        {header}
        <Loading label="Loading your marks…" />
      </section>
    );
  }
  if (exam.isError) {
    return (
      <section className="page">
        {header}
        <ErrorState
          title="Could not load your marks"
          message={errorMessage(exam.error)}
          onRetry={() => void exam.refetch()}
        />
      </section>
    );
  }

  const result = exam.data;
  return (
    <section className="page">
      {header}
      <div className="total-box">
        {result.absent ? (
          <Chip tone="bad">Absent</Chip>
        ) : (
          <p>
            Your total: <strong className="score">{result.totalScore}</strong> out of{' '}
            {result.maxScore}
          </p>
        )}
      </div>
      {result.absent ? (
        <Notice kind="info">
          You were marked absent for this exam, so every question scores 0.
        </Notice>
      ) : null}
      <ul className="cards cards-single">
        {result.questions.map((view) => (
          <QuestionCard key={view.number} examId={result.examId} view={view} />
        ))}
      </ul>
    </section>
  );
}
