import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import type { BoardStudentRow, CellStatus, QuestionCell } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { postToS3 } from '../../imaging/upload.js';
import { keys } from '../common/hooks.js';
import { STATUS_LABEL, hasPhoto, plural } from '../common/labels.js';
import { Notice, StatusChip } from '../common/ui.js';
import { PhotoCropper } from './PhotoCropper.js';
import { useSetAbsent } from './StudentPicker.js';

/** A cell, with a photo just sent counted as waiting even before the board is refreshed. */
function effective(cell: QuestionCell, sentNow: readonly number[]): CellStatus {
  return cell.status === 'NOT_SUBMITTED' && sentNow.includes(cell.number) ? 'QUEUED' : cell.status;
}

/**
 * The question to do next for this student: the next one after `current` without a photo, then any
 * earlier one without a photo; none when every question has a photo.
 */
export function nextQuestion(
  cells: readonly QuestionCell[],
  current: number | null,
  sentNow: readonly number[],
): number | null {
  const open = cells.filter((c) => !hasPhoto(effective(c, sentNow)));
  const after = open.find((c) => current === null || c.number > current);
  return (after ?? open[0])?.number ?? null;
}

export interface StudentUploadProps {
  examId: string;
  student: BoardStudentRow;
  /** The student after this one (not absent), to offer when this one is done. */
  nextStudent: BoardStudentRow | undefined;
  onPickStudent: (email: string) => void;
  onChooseAnother: () => void;
}

/** Upload one student's answer photos, question by question. */
export function StudentUpload({
  examId,
  student,
  nextStudent,
  onPickStudent,
  onChooseAnother,
}: StudentUploadProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const setAbsent = useSetAbsent(examId);
  const cells = student.questions;

  const [sentNow, setSentNow] = useState<number[]>([]);
  const [question, setQuestion] = useState<number | null>(() => nextQuestion(cells, null, []));
  const [replacing, setReplacing] = useState(false);
  const [file, setFile] = useState<File | undefined>();
  const [phase, setPhase] = useState<string | undefined>();
  const [justSent, setJustSent] = useState<number | undefined>();

  const cell = cells.find((c) => c.number === question);
  const status = cell ? effective(cell, sentNow) : undefined;
  const label = student.rollNo ? `${student.rollNo} · ${student.name}` : student.name;

  const send = useMutation({
    mutationFn: async (photo: Blob) => {
      if (question === null) throw new Error('Choose a question first.');
      const body = { examId, studentEmail: student.email, questionNumber: question };
      setPhase('Uploading the photo…');
      const presigned = await api.requestUploadUrl({ ...body, contentType: 'image/jpeg' });
      await postToS3(presigned, photo);
      setPhase('Sending it for grading…');
      return api.submitAnswer(body);
    },
    meta: { errorToast: false },
    onSuccess: async () => {
      const sent = question === null ? sentNow : [...sentNow, question];
      setSentNow(sent);
      setJustSent(question ?? undefined);
      setFile(undefined);
      setReplacing(false);
      setPhase(undefined);
      setQuestion(nextQuestion(cells, question, sent));
      await queryClient.invalidateQueries({ queryKey: keys.board(examId) });
    },
    onError: () => {
      setPhase(undefined);
      // The student may have been marked absent by someone else: show what is true now.
      void queryClient.invalidateQueries({ queryKey: keys.board(examId) });
    },
  });

  const pick = (number: number) => {
    send.reset();
    setFile(undefined);
    setReplacing(false);
    setJustSent(undefined);
    setQuestion(number);
  };

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = ''; // so choosing the same photo again still counts
    if (picked) {
      send.reset();
      setJustSent(undefined);
      setFile(picked);
    }
  };

  const header = (
    <div className="student-header">
      <div>
        <h2>{label}</h2>
        <p className="muted break">{student.email}</p>
      </div>
      <button type="button" className="button" onClick={onChooseAnother}>
        Choose another student
      </button>
    </div>
  );

  if (student.absent) {
    return (
      <div>
        {header}
        <Notice kind="warning">
          {student.name} is marked absent, so photos cannot be uploaded. If they did write the exam,
          mark them present.
        </Notice>
        <button
          type="button"
          className="button button-primary"
          disabled={setAbsent.isPending}
          onClick={() => setAbsent.mutate({ email: student.email, absent: false })}
        >
          Mark {student.name} present
        </button>
      </div>
    );
  }

  const remaining = cells.filter((c) => !hasPhoto(effective(c, sentNow)));
  const allDone = remaining.length === 0;

  return (
    <div>
      {header}

      <h3>Questions</h3>
      <p className="muted">
        {cells.length - remaining.length} of {cells.length} have a photo.
      </p>
      <ul className="question-grid" aria-label="Questions">
        {cells.map((c) => {
          const s = effective(c, sentNow);
          return (
            <li key={c.number}>
              <button
                type="button"
                className={`question-button${c.number === question ? ' is-selected' : ''}`}
                aria-pressed={c.number === question}
                aria-label={`Question ${c.number}: ${STATUS_LABEL[s]}`}
                onClick={() => pick(c.number)}
              >
                <span className="row-title">Q{c.number}</span>
                <StatusChip status={s} />
              </button>
            </li>
          );
        })}
      </ul>

      {justSent !== undefined ? (
        <Notice kind="success">Question {justSent} was sent for grading.</Notice>
      ) : null}

      {allDone && question === null ? (
        <div className="done">
          <Notice kind="success">
            All {plural(cells.length, 'question')} for {student.name} have been sent for grading.
          </Notice>
          <div className="actions">
            {nextStudent ? (
              <button
                type="button"
                className="button button-primary"
                onClick={() => onPickStudent(nextStudent.email)}
              >
                Next student: {nextStudent.rollNo ? `${nextStudent.rollNo} · ` : ''}
                {nextStudent.name}
              </button>
            ) : (
              <p className="muted">That was the last student in the list.</p>
            )}
            <button type="button" className="button" onClick={onChooseAnother}>
              Choose another student
            </button>
          </div>
        </div>
      ) : null}

      {cell && status ? (
        <div className="upload-step">
          <h3>Question {cell.number}</h3>

          {hasPhoto(status) && !replacing && !file ? (
            <div className="form">
              <p>
                This question already has a photo. Status: <StatusChip status={status} />
              </p>
              <button type="button" className="button" onClick={() => setReplacing(true)}>
                Replace photo
              </button>
            </div>
          ) : file ? (
            <PhotoCropper
              file={file}
              busy={send.isPending}
              busyText={phase}
              submitLabel={hasPhoto(status) ? 'Replace and grade again' : 'Send for grading'}
              onCancel={() => setFile(undefined)}
              onDone={(photo) => send.mutate(photo)}
            />
          ) : (
            <div className="form">
              {hasPhoto(status) ? (
                <Notice kind="warning">
                  A new photo replaces the old one, and the answer is graded again.
                </Notice>
              ) : null}
              <div className="capture">
                <label className="button button-primary file-button">
                  Take a photo
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={chosen}
                  />
                </label>
                <label className="button file-button">
                  Choose a file
                  <input type="file" accept="image/*" className="sr-only" onChange={chosen} />
                </label>
              </div>
              {replacing ? (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setReplacing(false)}
                >
                  Keep the current photo
                </button>
              ) : null}
            </div>
          )}

          {send.isError ? (
            <Notice kind="error">
              {errorMessage(send.error)} Your photo is still here: press the button again to retry.
            </Notice>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
