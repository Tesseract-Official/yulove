import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../api/errors.js';
import { useCurrentUser } from '../../session/MeContext.js';
import { ErrorState, Loading } from '../../ui/states.js';
import { useBoard } from '../common/hooks.js';
import { BatchSelect, ExamSelect } from '../common/pickers.js';
import { Notice, PageHeader } from '../common/ui.js';
import { StudentPicker } from './StudentPicker.js';
import { UploadScreen } from './UploadScreen.js';
import { UploadStatusList } from './UploadStatus.js';

/** What is remembered between visits: where the manager left off. */
interface LastUpload {
  batch: string;
  exam: string;
  student: string;
}

const storageKey = (email: string) => `yulove.upload.last:${email.toLowerCase()}`;

/** Browser storage can be missing or refused (private windows), so every use is guarded. */
function readLast(email: string): LastUpload | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(email));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<LastUpload>;
    return typeof value.batch === 'string' && typeof value.exam === 'string'
      ? { batch: value.batch, exam: value.exam, student: value.student ?? '' }
      : undefined;
  } catch {
    return undefined;
  }
}

function writeLast(email: string, last: LastUpload): void {
  try {
    window.localStorage.setItem(storageKey(email), JSON.stringify(last));
  } catch {
    // Nothing to do: the choice is simply not remembered.
  }
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

  if (board.data.students.some((s) => s.email === studentEmail)) {
    return (
      <UploadScreen
        key={examId}
        examId={examId}
        board={board.data}
        studentEmail={studentEmail}
        onStudentChange={(email) => select({ student: email })}
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
      <UploadStatusList />
    </>
  );
}

/**
 * Batch manager: pick the exam and student, then take, adjust and send each answer photo on one
 * screen (UploadScreen). The choices are kept in the address (?batch=&exam=&student=), so reloading
 * keeps the place, and the last exam and student are remembered for the next visit.
 */
export function UploadPage() {
  const me = useCurrentUser();
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

  // Coming back with nothing chosen: go back to where the manager left off.
  const arrivedEmpty = !batchId && !examId && !studentEmail;
  useEffect(() => {
    if (!arrivedEmpty) return;
    const last = readLast(me.email);
    if (last?.exam) select({ batch: last.batch, exam: last.exam, student: last.student });
  }, [arrivedEmpty, me.email, select]);

  // Remember the exam, and the last student that was chosen for it.
  useEffect(() => {
    if (!examId) return;
    const previous = readLast(me.email);
    const keepStudent = previous?.exam === examId ? previous.student : '';
    writeLast(me.email, { batch: batchId, exam: examId, student: studentEmail || keepStudent });
  }, [me.email, batchId, examId, studentEmail]);

  const working = Boolean(examId && studentEmail);

  return (
    <section className={working ? 'page capture-page' : 'page'}>
      {working ? null : (
        <PageHeader
          title="Upload answers"
          intro="Choose the exam, then the student, then photograph each answer page."
          backTo="/manager"
        />
      )}

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
