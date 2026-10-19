import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { AppealSummary, UpdateAppealBody } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { ApiError, errorMessage } from '../../api/errors.js';
import { postToS3 } from '../../imaging/upload.js';
import { useCurrentUser } from '../../session/MeContext.js';
import { EmptyState, ErrorState, Loading } from '../../ui/states.js';
import { ScoreTools } from '../common/ScoreTools.js';
import { AnswerDetail } from '../common/AnswerDetail.js';
import { keys, useAnswer, useAppeals } from '../common/hooks.js';
import { APPEAL_STATUS_LABEL, APPEAL_STATUS_TONE } from '../common/labels.js';
import { PhotoInputs } from '../common/PhotoInputs.js';
import { Chip, Field, Notice, PageHeader } from '../common/ui.js';
import { PhotoCropper } from '../manager/PhotoCropper.js';

const NOTE_MAX = 2000;

function Actions({ appeal }: { appeal: AppealSummary }) {
  const api = useApi();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [noteProblem, setNoteProblem] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | undefined>();
  const [phase, setPhase] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.appeals(appeal.examId) }),
      queryClient.invalidateQueries({
        queryKey: keys.answer(appeal.examId, appeal.studentEmail, appeal.questionNumber),
      }),
      queryClient.invalidateQueries({ queryKey: keys.board(appeal.examId) }),
      queryClient.invalidateQueries({ queryKey: keys.results(appeal.examId) }),
    ]);

  const answer = useMutation({
    mutationFn: async (action: { body: UpdateAppealBody; photo?: Blob }) => {
      if (action.photo) {
        // The new photo is stored under the answer's key; the re-grade then picks it up. This does
        // not call /answers/submit, which would grade the answer a second time.
        setPhase('Uploading the photo…');
        const presigned = await api.requestUploadUrl({
          examId: appeal.examId,
          studentEmail: appeal.studentEmail,
          questionNumber: appeal.questionNumber,
          contentType: 'image/jpeg',
        });
        await postToS3(presigned, action.photo);
        setPhase('Sending it for grading…');
      }
      return api.updateAppeal(appeal.appealId, action.body);
    },
    meta: { errorToast: false },
    onSuccess: async (_result, action) => {
      setDone(
        action.body.status === 'CLOSED'
          ? 'The appeal is closed. The student will see your note.'
          : 'Sent for grading again. Press Refresh to see the new result.',
      );
      setFile(undefined);
      setUploading(false);
      setPhase(undefined);
      setNote('');
      await refresh();
    },
    onError: () => setPhase(undefined),
  });

  const regrade = (photo?: Blob) => {
    const text = note.trim();
    if (text.length > NOTE_MAX)
      return setNoteProblem(`The note is too long (${NOTE_MAX} characters at most).`);
    setNoteProblem(undefined);
    answer.mutate({
      body: { status: 'RERUN', ...(text ? { note: text } : {}) },
      ...(photo ? { photo } : {}),
    });
  };

  const close = () => {
    const text = note.trim();
    if (text === '')
      return setNoteProblem('Write a note for the student before closing the appeal.');
    if (text.length > NOTE_MAX)
      return setNoteProblem(`The note is too long (${NOTE_MAX} characters at most).`);
    setNoteProblem(undefined);
    answer.mutate({ body: { status: 'CLOSED', note: text } });
  };

  if (appeal.status !== 'OPEN') {
    return (
      <section className="appeal-actions">
        <h2>Outcome</h2>
        <p>
          <Chip tone={APPEAL_STATUS_TONE[appeal.status]}>{APPEAL_STATUS_LABEL[appeal.status]}</Chip>
          {appeal.handledBy ? <span className="muted break"> by {appeal.handledBy}</span> : null}
        </p>
        {appeal.note ? <p>Note: {appeal.note}</p> : null}
        {done ? <Notice kind="success">{done}</Notice> : null}
      </section>
    );
  }

  return (
    <section className="appeal-actions">
      <h2>What would you like to do?</h2>
      {done ? <Notice kind="success">{done}</Notice> : null}

      {file ? (
        <PhotoCropper
          file={file}
          busy={answer.isPending}
          busyText={phase}
          submitLabel="Use this photo and grade again"
          onCancel={() => setFile(undefined)}
          onDone={(photo) => regrade(photo)}
        />
      ) : (
        <div className="form">
          <Field
            label="Note for the student"
            hint="Needed to close the appeal. Optional when you grade the answer again."
            error={noteProblem}
          >
            {(id, aria) => (
              <textarea
                id={id}
                {...aria}
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>

          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={answer.isPending}
              onClick={() => regrade()}
            >
              Re-grade as is
            </button>
            <button type="button" className="button" disabled={answer.isPending} onClick={close}>
              Close with a note
            </button>
          </div>

          {me.role === 'SUPER_ADMIN' ? (
            uploading ? (
              <div className="form">
                <p>
                  <strong>Upload a better photo</strong>
                </p>
                <PhotoInputs onPick={(picked) => setFile(picked)} />
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setUploading(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button"
                disabled={answer.isPending}
                onClick={() => setUploading(true)}
              >
                Upload a better photo and re-grade
              </button>
            )
          ) : (
            <p className="muted">
              To use a better photo, ask a batch manager to upload it on the Upload answers screen.
              Then come back, press Refresh, and re-grade or close the appeal. You can also grade
              the photo that is there, or close the appeal.
            </p>
          )}
        </div>
      )}

      {answer.isError ? (
        <Notice kind="error">
          {errorMessage(answer.error)}
          {answer.error instanceof ApiError && answer.error.status === 409
            ? ' Press Refresh to see the latest state.'
            : ''}
        </Notice>
      ) : null}
    </section>
  );
}

/** One appeal: what the student wrote, the answer, and what the reviewer can do about it. */
export function AppealDetailPage() {
  const { examId = '', appealId = '' } = useParams();
  const [params] = useSearchParams();
  const batch = params.get('batch');
  const queryClient = useQueryClient();

  const appeals = useAppeals(examId);
  const appeal = appeals.data?.find((a) => a.appealId === appealId);
  const answer = useAnswer(examId, appeal?.studentEmail ?? '', appeal?.questionNumber ?? 0);

  const backTo = `/teacher/appeals?exam=${encodeURIComponent(examId)}${
    batch ? `&batch=${encodeURIComponent(batch)}` : ''
  }`;
  const header = (
    <PageHeader
      title="Appeal"
      backTo={backTo}
      backLabel="Back to the appeals"
      {...(appeal
        ? {
            intro: `${appeal.rollNo ? `${appeal.rollNo} · ` : ''}${appeal.studentName ?? appeal.studentEmail} · Question ${appeal.questionNumber}`,
          }
        : {})}
    />
  );

  if (appeals.isPending) {
    return (
      <section className="page">
        {header}
        <Loading label="Loading the appeal…" />
      </section>
    );
  }
  if (appeals.isError) {
    return (
      <section className="page">
        {header}
        <ErrorState
          title="Could not load the appeal"
          message={errorMessage(appeals.error)}
          onRetry={() => void appeals.refetch()}
        />
      </section>
    );
  }
  if (!appeal) {
    return (
      <section className="page">
        {header}
        <EmptyState title="Appeal not found">
          This appeal could not be found. It may belong to another exam.
        </EmptyState>
      </section>
    );
  }

  const refreshing = answer.isFetching || appeals.isFetching;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.appeals(examId) }),
      queryClient.invalidateQueries({
        queryKey: keys.answer(examId, appeal.studentEmail, appeal.questionNumber),
      }),
    ]);

  return (
    <section className="page page-wide">
      {header}

      <div className="appeal-box">
        <p>
          <Chip tone={APPEAL_STATUS_TONE[appeal.status]}>{APPEAL_STATUS_LABEL[appeal.status]}</Chip>{' '}
          <span className="muted">{new Date(appeal.createdAt).toLocaleString()}</span>
        </p>
        <p className="break">
          <strong>The student wrote:</strong> “{appeal.message}”
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="button"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <span className="muted">
          Press Refresh after a re-grade to see the answer’s new status.
        </span>
      </div>

      <Actions appeal={appeal} />

      {answer.isPending ? (
        <Loading label="Loading the answer…" />
      ) : answer.isError ? (
        <ErrorState
          title="Could not load the answer"
          message={errorMessage(answer.error)}
          onRetry={() => void answer.refetch()}
        />
      ) : (
        <>
          <AnswerDetail answer={answer.data} wide />
          <ScoreTools answer={answer.data} />
        </>
      )}
    </section>
  );
}
