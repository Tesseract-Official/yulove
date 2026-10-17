import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ExamBoardResponse } from '@yulove/shared';
import { errorMessage } from '../../api/errors.js';
import { ErrorState, Loading } from '../../ui/states.js';
import { useBoard } from '../common/hooks.js';
import { BatchSelect, ExamSelect } from '../common/pickers.js';
import { Notice, PageHeader } from '../common/ui.js';
import { StudentPicker } from './StudentPicker.js';
import { StudentUpload } from './StudentUpload.js';

/** The student after `email` in the list who is not absent. */
function followingStudent(board: ExamBoardResponse, email: string) {
  const index = board.students.findIndex((s) => s.email === email);
  return board.students.slice(index + 1).find((s) => !s.absent);
}

function ExamWork({
  examId,
  studentEmail,
  select,
}: {
  examId: string;
  studentEmail: string;
  select: (patch: Record<string, string>) => void;
}) {
  const board = useBoard(examId);

  if (board.isPending) return <Loading label="Loading the students…" />;
  if (board.isError) {
    return (
      <ErrorState
        title="Could not load the students"
        message={errorMessage(board.error)}
        onRetry={() => void board.refetch()}
      />
    );
  }

  const student = board.data.students.find((s) => s.email === studentEmail);
  if (student) {
    return (
      <StudentUpload
        key={student.email}
        examId={examId}
        student={student}
        nextStudent={followingStudent(board.data, student.email)}
        onPickStudent={(email) => select({ student: email })}
        onChooseAnother={() => select({ student: '' })}
      />
    );
  }

  return (
    <>
      {studentEmail ? (
        <Notice kind="warning">That student is not in this exam. Choose another student.</Notice>
      ) : null}
      <StudentPicker board={board.data} onPick={(email) => select({ student: email })} />
    </>
  );
}

/**
 * Batch manager: batch → exam → student → question → photo. The choices are kept in the address
 * (?batch=&exam=&student=), so reloading the page keeps the place.
 */
export function UploadPage() {
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch') ?? '';
  const examId = params.get('exam') ?? '';
  const studentEmail = params.get('student') ?? '';

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
    (id: string) => select({ batch: id, ...(id === batchId ? {} : { exam: '', student: '' }) }),
    [select, batchId],
  );

  return (
    <section className="page">
      <PageHeader
        title="Upload answers"
        intro="Choose the exam, then the student, then photograph each answer page."
        backTo="/manager"
      />

      {!studentEmail ? (
        <div className="form">
          <BatchSelect value={batchId} onChange={chooseBatch} />
          <ExamSelect
            batchId={batchId}
            value={examId}
            onChange={(id) => select({ exam: id, student: '' })}
            statuses={['READY', 'PUBLISHED']}
            emptyHint="No exam in this batch is ready for answers yet. Ask the teacher to finish the exam."
          />
        </div>
      ) : null}

      {examId ? <ExamWork examId={examId} studentEmail={studentEmail} select={select} /> : null}
    </section>
  );
}
