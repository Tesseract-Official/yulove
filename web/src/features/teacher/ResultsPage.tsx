import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ExamResultsResponse, ResultCell, ResultStudentRow } from '@yulove/shared';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { useResults } from '../common/hooks.js';
import { FAIL_REASON_TEXT, STATUS_LABEL, plural } from '../common/labels.js';
import { BatchSelect, ExamSelect } from '../common/pickers.js';
import { Chip, Notice, PageHeader, StatusChip } from '../common/ui.js';

/** Students whose name, roll number or email contains the text. */
export function matchesSearch(student: ResultStudentRow, search: string): boolean {
  const text = search.trim().toLowerCase();
  return (
    text === '' ||
    (student.rollNo ?? '').toLowerCase().includes(text) ||
    student.name.toLowerCase().includes(text) ||
    student.email.toLowerCase().includes(text)
  );
}

function ScoreCell({
  examId,
  batchId,
  student,
  cell,
}: {
  examId: string;
  batchId: string;
  student: ResultStudentRow;
  cell: ResultCell;
}) {
  const link = `/teacher/answer/${encodeURIComponent(examId)}/${encodeURIComponent(
    student.email,
  )}/${cell.number}?batch=${encodeURIComponent(batchId)}`;

  if (student.absent) return <td className="cell-muted">—</td>;

  let content;
  let label: string;
  if (cell.status === 'GRADED') {
    label = `${cell.score} out of ${cell.marks}`;
    content = (
      <>
        <span className="score">
          {cell.score} / {cell.marks}
        </span>
        {cell.overridden ? <Chip tone="progress">Adjusted</Chip> : null}
      </>
    );
  } else if (cell.status === 'FAILED_TO_GRADE') {
    label = 'could not be graded';
    content = (
      <>
        <Chip tone="bad">Could not be graded</Chip>
        {cell.failReason ? (
          <span className="muted">{FAIL_REASON_TEXT[cell.failReason]}</span>
        ) : null}
      </>
    );
  } else if (cell.status === 'NOT_SUBMITTED') {
    return <td className="cell-muted">No photo</td>;
  } else {
    label = STATUS_LABEL[cell.status].toLowerCase();
    content = <StatusChip status={cell.status} />;
  }

  return (
    <td>
      <Link
        to={link}
        className="result-link"
        aria-label={`Question ${cell.number} for ${student.name}: ${label}. Open the answer`}
      >
        {content}
      </Link>
    </td>
  );
}

function ResultsTable({ results, batchId }: { results: ExamResultsResponse; batchId: string }) {
  const [search, setSearch] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);

  const failedStudents = results.students.filter((s) => !s.absent && s.failedToGrade > 0);
  const failedAnswers = failedStudents.reduce((sum, s) => sum + s.failedToGrade, 0);
  const absentCount = results.students.filter((s) => s.absent).length;

  const shown = useMemo(
    () =>
      results.students.filter(
        (s) => matchesSearch(s, search) && (!onlyFailed || (!s.absent && s.failedToGrade > 0)),
      ),
    [results.students, search, onlyFailed],
  );

  return (
    <div>
      <h2>{results.title}</h2>
      <p className="muted">
        {results.date} · {plural(results.students.length, 'student')}
        {absentCount > 0 ? ` · ${absentCount} absent` : ''} · {results.maxScore} marks in total
        {results.examStatus === 'PUBLISHED'
          ? ' · Results are published'
          : ' · Results are not published yet'}
      </p>

      {failedAnswers > 0 ? (
        <Notice kind="warning">
          {plural(failedAnswers, 'answer')} could not be graded (
          {plural(failedStudents.length, 'student')}). Open them to check, or ask the batch manager
          to grade them again.
        </Notice>
      ) : null}

      <div className="toolbar">
        <div className="field inline">
          <label htmlFor="results-search">Find a student</label>
          <input
            id="results-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={(e) => setOnlyFailed(e.target.checked)}
          />
          <span>Only answers that could not be graded</span>
        </label>
      </div>

      {shown.length === 0 ? (
        <EmptyState title="Nobody to show">
          {results.students.length === 0
            ? 'There are no students in this exam yet.'
            : 'No student matches.'}
        </EmptyState>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Results table">
          <table className="results-table">
            <thead>
              <tr>
                <th scope="col">Roll no.</th>
                <th scope="col">Name</th>
                {results.questions.map((q) => (
                  <th key={q.number} scope="col">
                    Q{q.number}
                    <span className="muted"> ({q.marks})</span>
                  </th>
                ))}
                <th scope="col">Total ({results.maxScore})</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((student) => (
                <tr key={student.email}>
                  <td>{student.rollNo ?? '—'}</td>
                  <th scope="row" className="name-cell">
                    {student.name}
                    <span className="muted break"> {student.email}</span>
                  </th>
                  {student.absent ? (
                    <td colSpan={results.questions.length}>
                      <Chip tone="bad">Absent</Chip>
                    </td>
                  ) : (
                    student.questions.map((cell) => (
                      <ScoreCell
                        key={cell.number}
                        examId={results.examId}
                        batchId={batchId}
                        student={student}
                        cell={cell}
                      />
                    ))
                  )}
                  <td className="total-cell">
                    {student.absent ? (
                      <span className="score">0</span>
                    ) : (
                      <span className="score">{student.totalScore}</span>
                    )}
                    {!student.absent && student.failedToGrade > 0 ? (
                      <span className="muted"> (incomplete)</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        A total marked “incomplete” will go up once the questions that could not be graded are
        graded again.
      </p>
    </div>
  );
}

/** Teacher: every student's marks for an exam, and a way into each answer. */
export function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch') ?? '';
  const examId = params.get('exam') ?? '';
  const results = useResults(examId || undefined);

  const select = (patch: Record<string, string>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  return (
    <section className="page">
      <PageHeader
        title="Results"
        intro="Choose an exam to see every student’s marks."
        backTo="/teacher"
      />
      <div className="form">
        <BatchSelect
          value={batchId}
          onChange={(id) => select({ batch: id, ...(id === batchId ? {} : { exam: '' }) })}
        />
        <ExamSelect
          batchId={batchId}
          value={examId}
          onChange={(id) => select({ exam: id })}
          statuses={['READY', 'PUBLISHED']}
          emptyHint="No exam in this batch has its PDF yet, so there are no results to see."
        />
      </div>

      {examId ? (
        results.isPending ? (
          <Loading label="Loading the results…" />
        ) : results.isError ? (
          <ErrorState
            title="Could not load the results"
            message={errorMessage(results.error)}
            onRetry={() => void results.refetch()}
          />
        ) : (
          <ResultsTable results={results.data} batchId={batchId} />
        )
      ) : null}
    </section>
  );
}
