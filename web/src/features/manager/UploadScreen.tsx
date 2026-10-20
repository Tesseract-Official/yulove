import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { BoardStudentRow, ExamBoardResponse } from '@yulove/shared';
import { errorMessage } from '../../api/errors.js';
import { cropAndCompress, type CompressedPhoto } from '../../imaging/imaging.js';
import { Loading } from '../../ui/states.js';
import { hasPhoto } from '../common/labels.js';
import { Notice } from '../common/ui.js';
import { PhotoAdjuster, type Edit } from './PhotoAdjuster.js';
import { PhotoPreview } from './PhotoPreview.js';
import { useSetAbsent } from './StudentPicker.js';
import { UploadStatusList } from './UploadStatus.js';
import {
  allCovered,
  canUpload,
  firstOpenQuestion,
  neighbourQuestion,
  neighbourStudent,
  nextTarget,
  questionMark,
  type Mark,
  type QueueLookup,
  type Target,
} from './nextTarget.js';
import { useUploadQueue } from './uploadQueue.js';
import { useWorkingPhoto } from './useWorkingPhoto.js';

type Stage = 'capture' | 'adjust' | 'preview';

const studentLabel = (student: BoardStudentRow) =>
  student.rollNo ? `${student.rollNo} · ${student.name}` : student.name;

const MARK_TEXT: Record<Mark, string> = {
  photo: '✓',
  sending: '…',
  failed: '!',
  none: '•',
};
const MARK_NAME: Record<Mark, string> = {
  photo: 'has a photo',
  sending: 'is being sent',
  failed: 'could not be sent',
  none: 'has no photo yet',
};

export interface UploadScreenProps {
  examId: string;
  board: ExamBoardResponse;
  /** The student to start with. */
  studentEmail: string;
  /** Called whenever the student being photographed changes, to keep the address up to date. */
  onStudentChange: (email: string) => void;
  /** Go back to the list of students. */
  onChooseAnother: () => void;
}

/**
 * The whole job on one screen: take the photo, adjust it, look at the result, send it, and be
 * pointed at the camera for the next question. Sending only queues the photo: it goes up in the
 * background (see uploadQueue.tsx), so the camera is ready again straight away.
 */
export function UploadScreen({
  examId,
  board,
  studentEmail,
  onStudentChange,
  onChooseAnother,
}: UploadScreenProps) {
  const queue = useUploadQueue();
  const setAbsent = useSetAbsent(examId);
  const lookup: QueueLookup = useCallback(
    (email, question) => queue.statusOf(examId, email, question),
    [queue, examId],
  );

  const [target, setTarget] = useState<Target>(() => {
    const first = board.students.find((s) => s.email === studentEmail);
    return {
      email: studentEmail,
      question: first ? firstOpenQuestion(first, lookup) : 1,
    };
  });
  const [stage, setStage] = useState<Stage>('capture');
  const [file, setFile] = useState<File | undefined>();
  const [edit, setEdit] = useState<Edit | undefined>();
  const [result, setResult] = useState<(CompressedPhoto & { url: string }) | undefined>();
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [justSent, setJustSent] = useState<string | undefined>();

  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const student = board.students.find((s) => s.email === target.email);
  const cell = student?.questions.find((c) => c.number === target.question);
  const working = useWorkingPhoto(file);

  // Each new photo starts from the page edges found in it (or the whole photo).
  useEffect(() => {
    if (working.status === 'ready') {
      setEdit({ rotation: 0, box: working.photo.suggestedBox });
    }
  }, [working]);

  // Free the temporary address of the preview when it is replaced or the screen goes away.
  useEffect(() => {
    const url = result?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [result]);

  const clearPhoto = () => {
    setFile(undefined);
    setEdit(undefined);
    setResult(undefined);
    setProblem(undefined);
    setStage('capture');
  };

  const goTo = (next: Target) => {
    setTarget(next);
    if (next.email !== target.email) onStudentChange(next.email);
  };

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setJustSent(undefined);
    setProblem(undefined);
    setResult(undefined);
    setEdit(undefined);
    setFile(chosen);
    setStage('adjust');
  };

  const openCamera = () => cameraRef.current?.click();

  const retake = () => {
    clearPhoto();
    openCamera(); // still inside the tap, so the browser allows it
  };

  const makeResult = async () => {
    if (working.status !== 'ready' || !edit) return;
    setMaking(true);
    setProblem(undefined);
    try {
      const out = await cropAndCompress({
        source: working.photo.blob,
        area: edit.box,
        rotation: edit.rotation,
      });
      setResult({ ...out, url: URL.createObjectURL(out.blob) });
      setStage('preview');
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setMaking(false);
    }
  };

  const send = () => {
    if (!result || !student) return;
    const here: Target = { email: student.email, question: target.question };
    const accepted = queue.enqueue({
      examId,
      studentEmail: student.email,
      studentLabel: studentLabel(student),
      question: here.question,
      photo: result.blob,
    });
    if (!accepted) {
      setProblem('The photo for this question is still going up. Wait a moment, then send again.');
      return;
    }
    setJustSent(`Q${here.question} for ${studentLabel(student)} is on its way.`);

    // The photo just queued counts as covered, although the queue has not re-rendered yet.
    const next = nextTarget(
      board.students,
      (email, question) =>
        email === here.email && question === here.question ? 'queued' : lookup(email, question),
      here,
    );
    clearPhoto();
    if (next) {
      goTo(next);
      openCamera(); // straight to the camera for the next question
    }
  };

  if (!student) return null;

  const cells = student.questions;
  const previousQuestion = neighbourQuestion(cells, target.question, 'previous');
  const followingQuestion = neighbourQuestion(cells, target.question, 'next');
  const previousStudent = neighbourStudent(board.students, student.email, 'previous');
  const followingStudent = neighbourStudent(board.students, student.email, 'next');
  const navigating = stage === 'capture';
  const everyoneDone = allCovered(board.students, lookup);
  const title = `question ${target.question} of ${studentLabel(student)}`;

  const jumpToStudent = (other: BoardStudentRow | undefined) =>
    other && goTo({ email: other.email, question: firstOpenQuestion(other, lookup) });

  const header = (
    <header className="flow-head">
      <div className="flow-title">
        <strong className="break">{studentLabel(student)}</strong>
        <span className="muted break">{board.title}</span>
      </div>
      <div className="flow-nav">
        <button
          type="button"
          className="button"
          aria-label="Previous student"
          disabled={!navigating || !previousStudent}
          onClick={() => jumpToStudent(previousStudent)}
        >
          ‹ Student
        </button>
        <button
          type="button"
          className="button"
          aria-label="Previous question"
          disabled={!navigating || previousQuestion === undefined}
          onClick={() =>
            previousQuestion !== undefined && goTo({ ...target, question: previousQuestion })
          }
        >
          ‹
        </button>
        <span className="flow-question" aria-live="polite">
          Q{target.question} of {cells.length}
        </span>
        <button
          type="button"
          className="button"
          aria-label="Next question"
          disabled={!navigating || followingQuestion === undefined}
          onClick={() =>
            followingQuestion !== undefined && goTo({ ...target, question: followingQuestion })
          }
        >
          ›
        </button>
        <button
          type="button"
          className="button"
          aria-label="Next student"
          disabled={!navigating || !followingStudent}
          onClick={() => jumpToStudent(followingStudent)}
        >
          Student ›
        </button>
      </div>
      <button
        type="button"
        className="button button-quiet"
        disabled={!navigating}
        onClick={onChooseAnother}
      >
        Choose another student
      </button>
    </header>
  );

  const progress = (
    <ul className="progress-row" aria-label={`Photos for ${studentLabel(student)}`}>
      {cells.map((c) => {
        const mark = questionMark(c, lookup(student.email, c.number));
        const item = queue.itemFor(examId, student.email, c.number);
        return (
          <li key={c.number}>
            <button
              type="button"
              className={`progress-chip progress-${mark}${c.number === target.question ? ' is-selected' : ''}`}
              aria-pressed={c.number === target.question}
              aria-label={`Question ${c.number} ${MARK_NAME[mark]}`}
              disabled={!navigating}
              onClick={() => goTo({ ...target, question: c.number })}
            >
              Q{c.number} {MARK_TEXT[mark]}
              {mark === 'sending' && item ? ` ${Math.round(item.progress * 100)}%` : ''}
            </button>
          </li>
        );
      })}
    </ul>
  );

  // The camera and the gallery stay mounted for the whole visit, so a camera opened by the Send tap
  // is still there when the photo comes back.
  const inputs = (
    <>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label="Take a photo"
        tabIndex={-1}
        onChange={picked}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label="Choose from gallery"
        tabIndex={-1}
        onChange={picked}
      />
    </>
  );

  if (student.absent) {
    return (
      <div className="flow">
        {inputs}
        {header}
        <Notice kind="warning">
          {student.name} is marked absent, so photos cannot be uploaded. If they did write the exam,
          mark them present.
        </Notice>
        <div className="actions">
          <button
            type="button"
            className="button button-primary"
            disabled={setAbsent.isPending}
            onClick={() => setAbsent.mutate({ email: student.email, absent: false })}
          >
            Mark {student.name} present
          </button>
        </div>
        <UploadStatusList />
      </div>
    );
  }
  if (!canUpload(student)) {
    return (
      <div className="flow">
        {inputs}
        {header}
        <Notice kind="warning">
          {student.name} has been switched off, so photos cannot be uploaded.
        </Notice>
      </div>
    );
  }

  const existing = cell ? hasPhoto(cell.status) : false;

  return (
    <div className="flow">
      {inputs}
      {header}
      {progress}

      {stage === 'capture' ? (
        <div className="capture-stage">
          {justSent ? <Notice kind="success">{justSent}</Notice> : null}
          {everyoneDone ? (
            <Notice kind="success">
              Every student has a photo for every question. Photos still going up are listed below.
            </Notice>
          ) : null}
          <h2 className="capture-title">Question {target.question}</h2>
          {existing ? (
            <Notice kind="warning">
              This question already has a photo. A new photo replaces it and the answer is graded
              again.
            </Notice>
          ) : null}
          <div className="capture-buttons">
            <button
              type="button"
              className="button button-primary capture-take"
              onClick={openCamera}
            >
              Take a photo
            </button>
            <button type="button" className="button" onClick={() => galleryRef.current?.click()}>
              Choose from gallery
            </button>
          </div>
        </div>
      ) : null}

      {stage === 'adjust' && working.status === 'error' ? (
        <div className="form">
          <Notice kind="error">{working.message}</Notice>
          <button type="button" className="button button-primary" onClick={retake}>
            Retake
          </button>
        </div>
      ) : null}
      {stage === 'adjust' && working.status === 'loading' ? (
        <Loading label="Opening the photo…" />
      ) : null}
      {stage === 'adjust' && working.status === 'ready' && edit ? (
        <PhotoAdjuster
          photo={working.photo}
          edit={edit}
          onEdit={setEdit}
          onRetake={retake}
          onNext={() => void makeResult()}
          busy={making}
        />
      ) : null}

      {stage === 'preview' && result ? (
        <PhotoPreview
          photo={{
            url: result.url,
            width: result.width,
            height: result.height,
            size: result.blob.size,
          }}
          title={title}
          sendLabel={existing ? 'Send and replace' : 'Send'}
          onBack={() => setStage('adjust')}
          onSend={send}
        />
      ) : null}

      {problem ? <Notice kind="error">{problem}</Notice> : null}
      <UploadStatusList />
    </div>
  );
}
