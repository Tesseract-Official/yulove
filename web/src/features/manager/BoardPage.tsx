import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  answerFailureText,
  type BoardStudentRow,
  type CellStatus,
  type ExamBoardResponse,
  type QuestionCell,
} from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { keys, useBoard } from '../common/hooks.js';
import { FAIL_REASON_TEXT, hasPhoto, isGrading, plural } from '../common/labels.js';
import { BatchSelect, ExamSelect } from '../common/pickers.js';
import { DownloadPdfButton } from '../common/DownloadPdfButton.js';
import { Chip, PageHeader, StatusChip } from '../common/ui.js';
import { PublishBar } from './PublishBar.js';

type Filter = 'all' | 'attention' | 'grading';

const needsAttention = (c: QuestionCell) =>
  c.status === 'FAILED_TO_GRADE' || c.status === 'NOT_SUBMITTED';

/** Whether a student has any question that matches the filter (absent students never need photos). */
export function matchesFilter(student: BoardStudentRow, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (student.absent) return false;
  return student.questions.some(
    filter === 'attention' ? needsAttention : (c) => isGrading(c.status),
  );
}

function Cell({
  examId,
  batchId,
  student,
  cell,
}: {
  examId: string;
  batchId: string;
  student: BoardStudentRow;
  cell: QuestionCell;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const rerun = useMutation({
    mutationFn: () => api.rerunAnswer(examId, student.email, cell.number),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.board(examId) }),
  });

  const answerLink = `/manager/answer/${encodeURIComponent(examId)}/${encodeURIComponent(
    student.email,
  )}/${cell.number}?batch=${encodeURIComponent(batchId)}`;

  return (
    <li className="cell">
      <div className="cell-head">
        <span className="row-title">Q{cell.number}</span>
        <StatusChip status={cell.status} />
        {cell.status === 'GRADED' ? (
          <span className="score">
            {cell.score} / {cell.marks}
          </span>
        ) : null}
      </div>

      {cell.status === 'FAILED_TO_GRADE' ? (
        <div className="cell-detail">
          <p>
            {cell.failReason
              ? FAIL_REASON_TEXT[cell.failReason]
              : 'This answer could not be graded.'}
          </p>
          {cell.failDetail ? <p className="muted">{answerFailureText(cell.failDetail)}</p> : null}
          <button
            type="button"
            className="button"
            aria-label={`Grade question ${cell.number} again for ${student.name}`}
            disabled={rerun.isPending}
            onClick={() => rerun.mutate()}
          >
            {rerun.isPending ? 'Sending…' : 'Grade again'}
          </button>
        </div>
      ) : null}

      {hasPhoto(cell.status) ? (
        <Link
          to={answerLink}
          className="cell-link"
          aria-label={`View question ${cell.number} for ${student.name}`}
        >
          View answer
        </Link>
      ) : null}
    </li>
  );
}

function StudentCard({
  examId,
  batchId,
  student,
}: {
  examId: string;
  batchId: string;
  student: BoardStudentRow;
}) {
  return (
    <li className="card-item">
      <div className="card-head">
        <span className="row-title">
          {student.rollNo ? `${student.rollNo} · ` : ''}
          {student.name}
        </span>
        {student.absent ? (
          <Chip tone="bad">Absent</Chip>
        ) : (
          <span className="score">
            {student.totalScore} / {student.maxScore}
          </span>
        )}
      </div>
      <p className="muted break">{student.email}</p>
      {student.absent ? (
        <p className="muted">Marked absent: 0 marks.</p>
      ) : (
        <ul className="cells">
          {student.questions.map((cell) => (
            <Cell
              key={cell.number}
              examId={examId}
              batchId={batchId}
              student={student}
              cell={cell}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

const COUNT_ORDER: CellStatus[] = [
  'GRADED',
  'QUEUED',
  'TRANSCRIBING',
  'RUNNING',
  'FAILED_TO_GRADE',
  'NOT_SUBMITTED',
];

function BoardView({ board, batchId }: { board: ExamBoardResponse; batchId: string }) {
  const query = useBoard(board.examId);
  const [filter, setFilter] = useState<Filter>('all');
  const students = board.students.filter((s) => matchesFilter(s, filter));
  const updated = query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : undefined;

  return (
    <div>
      <h2>{board.title}</h2>
      <p>
        <DownloadPdfButton examId={board.examId} />
      </p>
      <PublishBar board={board} />

      <ul className="counts" aria-label="Answers by status">
        {COUNT_ORDER.filter((status) => (board.counts[status] ?? 0) > 0).map((status) => (
          <li key={status}>
            <StatusChip status={status} /> {board.counts[status]}
          </li>
        ))}
      </ul>

      <div className="toolbar">
        <button
          type="button"
          className="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        {updated ? <span className="muted">Updated {updated.toLocaleTimeString()}</span> : null}
        <div className="field inline">
          <label htmlFor="board-filter">Show</label>
          <select
            id="board-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            <option value="all">Everyone</option>
            <option value="attention">Needs attention (failed or no photo)</option>
            <option value="grading">Still being graded</option>
          </select>
        </div>
      </div>
      <p className="muted">The board does not update by itself. Press Refresh to see progress.</p>

      {students.length === 0 ? (
        <EmptyState title="Nobody to show">
          {board.students.length === 0
            ? 'There are no students in this exam yet.'
            : 'No student matches this filter.'}
        </EmptyState>
      ) : (
        <>
          <p className="muted">{plural(students.length, 'student')}</p>
          <ul className="cards">
            {students.map((student) => (
              <StudentCard
                key={student.email}
                examId={board.examId}
                batchId={batchId}
                student={student}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Batch manager: how every student's answers are doing, grade failed ones again, and publish. */
export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch') ?? '';
  const examId = params.get('exam') ?? '';
  const board = useBoard(examId || undefined);

  const select = useCallback(
    (patch: Record<string, string>) =>
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
      ),
    [setParams],
  );
  const chooseBatch = useCallback(
    (id: string) => select({ batch: id, ...(id === batchId ? {} : { exam: '' }) }),
    [select, batchId],
  );

  return (
    <section className="page">
      <PageHeader
        title="Check grading and publish"
        intro="See how each answer is doing. Results stay hidden from students until you publish."
        backTo="/manager"
      />
      <div className="form">
        <BatchSelect value={batchId} onChange={chooseBatch} />
        <ExamSelect
          batchId={batchId}
          value={examId}
          onChange={(id) => select({ exam: id })}
          statuses={['READY', 'PUBLISHED']}
          emptyHint="No exam in this batch has been opened for answers yet."
        />
      </div>

      {examId ? (
        board.isPending ? (
          <Loading label="Loading the board…" />
        ) : board.isError ? (
          <ErrorState
            title="Could not load the board"
            message={errorMessage(board.error)}
            onRetry={() => void board.refetch()}
          />
        ) : (
          <BoardView board={board.data} batchId={batchId} />
        )
      ) : null}
    </section>
  );
}
