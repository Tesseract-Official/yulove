import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { ExamDetailResponse, QuestionSummary } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { useCurrentUser } from '../../session/MeContext.js';
import { ErrorState, Loading } from '../../ui/states.js';
import { startDownload } from '../common/download.js';
import {
  DEFAULT_MARKS,
  moveItem,
  totalMarks,
  validateExamForm,
  type ExamFormErrors,
  type ExamFormItem,
  type ExamFormValues,
} from '../common/examForm.js';
import { keys, useBatches, useExam, useQuestions } from '../common/hooks.js';
import { EXAM_STATUS_LABEL, EXAM_STATUS_TONE, TEST_STATE_LABEL } from '../common/labels.js';
import { BatchSelect } from '../common/pickers.js';
import { Chip, Field, Notice, PageHeader } from '../common/ui.js';

const today = () => new Date().toISOString().slice(0, 10);

function initialValues(detail: ExamDetailResponse | undefined): ExamFormValues {
  if (!detail) return { batchId: '', title: '', date: today(), items: [] };
  return {
    batchId: detail.exam.batchId,
    title: detail.exam.title,
    date: detail.exam.date,
    items: detail.exam.questions.map((q) => ({
      questionId: q.questionId,
      version: q.version,
      title: q.title ?? 'A question that no longer exists',
      marks: String(q.marks),
    })),
  };
}

function ExamEditor({ detail }: { detail?: ExamDetailResponse }) {
  const api = useApi();
  const me = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const arrivedWith = (location.state as { notice?: string } | null)?.notice;

  const baseline = useMemo(() => initialValues(detail), [detail]);
  const [values, setValues] = useState<ExamFormValues>(baseline);
  const [errors, setErrors] = useState<ExamFormErrors>({});
  const [notice, setNotice] = useState<string | undefined>(arrivedWith);
  const [toAdd, setToAdd] = useState('');

  const batches = useBatches();
  const questions = useQuestions();

  const exam = detail?.exam;
  const published = exam?.status === 'PUBLISHED';
  const mine = exam ? exam.createdBy === me.email || me.role === 'SUPER_ADMIN' : true;
  const readOnly = Boolean(exam) && (published || !detail?.canEdit);
  const questionsLocked = readOnly || Boolean(detail?.hasAnswers);
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);

  const availableToAdd: QuestionSummary[] = (questions.data ?? []).filter(
    (q) => q.testStatus === 'APPROVED' && !values.items.some((i) => i.questionId === q.questionId),
  );

  const set = <K extends keyof ExamFormValues>(key: K, value: ExamFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setItem = (index: number, patch: Partial<ExamFormItem>) =>
    set(
      'items',
      values.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.createExam>[0]) =>
      exam ? api.updateExam(exam.examId, body) : api.createExam(body),
    meta: { errorToast: false },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.allExams }),
        queryClient.invalidateQueries({ queryKey: ['exams'] }),
        queryClient.invalidateQueries({ queryKey: keys.exam(result.exam.examId) }),
      ]);
      if (!exam) {
        navigate(`/teacher/exams/${result.exam.examId}`, {
          state: { notice: 'Exam saved. Next: make its PDF.' },
        });
      } else if (result.changed === false) {
        setNotice('Nothing was different, so nothing was saved.');
      } else {
        setNotice('Saved. Make the PDF again so it matches the changes.');
      }
    },
  });

  const makePdf = useMutation({
    mutationFn: () => api.generateExamPdf(exam?.examId ?? ''),
    meta: { errorToast: false },
    onSuccess: async () => {
      setNotice('The PDF is ready. You can download it now.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.exam(exam?.examId ?? '') }),
        queryClient.invalidateQueries({ queryKey: keys.allExams }),
      ]);
    },
  });

  const download = useMutation({
    mutationFn: () => api.getExamPdfLink(exam?.examId ?? ''),
    meta: { errorToast: false },
    onSuccess: (link) => startDownload(link.url, link.filename),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(undefined);
    const result = validateExamForm(values);
    if (!result.ok) return setErrors(result.errors);
    setErrors({});
    save.mutate(result.body);
  };

  const addQuestion = () => {
    const q = availableToAdd.find((candidate) => candidate.questionId === toAdd);
    if (!q) return;
    set('items', [
      ...values.items,
      { questionId: q.questionId, version: q.version, title: q.title, marks: DEFAULT_MARKS },
    ]);
    setToAdd('');
  };

  const batchName = (id: string) => batches.data?.find((b) => b.batchId === id)?.name ?? id;

  return (
    <div>
      {notice ? <Notice kind="success">{notice}</Notice> : null}

      {exam ? (
        <p>
          <Chip tone={EXAM_STATUS_TONE[exam.status]}>{EXAM_STATUS_LABEL[exam.status]}</Chip>{' '}
          {exam.createdBy !== me.email ? (
            <span className="muted break">Made by {exam.createdBy}</span>
          ) : null}
        </p>
      ) : null}

      {published ? (
        <Notice kind="info">
          This exam is published, so it cannot be changed. You can still make and download its PDF.
        </Notice>
      ) : exam && !detail?.canEdit ? (
        <Notice kind="info">
          Only {exam.createdBy} can change this exam. You can look at it here.
        </Notice>
      ) : detail?.hasAnswers ? (
        <Notice kind="warning">
          Answers have been uploaded for this exam, so its questions and marks are locked. You can
          still change the title and the date.
        </Notice>
      ) : null}

      {Object.keys(errors).length > 0 ? (
        <Notice kind="error">Some answers need fixing. They are marked below.</Notice>
      ) : null}

      <form className="form form-wide" onSubmit={submit} noValidate>
        {exam ? (
          <p>
            <strong>Batch:</strong> {batchName(exam.batchId)}
          </p>
        ) : (
          <div className={errors.batchId ? 'has-error' : undefined}>
            <BatchSelect value={values.batchId} onChange={(id) => set('batchId', id)} />
            {errors.batchId ? <p className="field-error">{errors.batchId}</p> : null}
          </div>
        )}

        <Field label="Title" error={errors.title}>
          {(id, aria) => (
            <input
              id={id}
              {...aria}
              value={values.title}
              disabled={readOnly}
              onChange={(e) => set('title', e.target.value)}
            />
          )}
        </Field>
        <Field label="Date of the exam" error={errors.date}>
          {(id, aria) => (
            <input
              id={id}
              {...aria}
              type="date"
              value={values.date}
              disabled={readOnly}
              onChange={(e) => set('date', e.target.value)}
            />
          )}
        </Field>

        <fieldset className="builder">
          <legend>Questions, in the order students will see them</legend>
          {errors.questions ? <p className="field-error">{errors.questions}</p> : null}
          {values.items.length === 0 ? (
            <p className="muted">No questions yet. Add one below.</p>
          ) : (
            <ol className="builder-list">
              {values.items.map((item, index) => (
                <li key={item.questionId} className="builder-item">
                  <div className="builder-main">
                    <span className="row-title">
                      Question {index + 1}: {item.title}
                    </span>
                    <span className="muted">Version {item.version}</span>
                    {(() => {
                      // Only questions the exam already had can have lost their approval.
                      const saved = exam?.questions.find(
                        (q) => q.questionId === item.questionId && q.version === item.version,
                      );
                      if (!saved || saved.testStatus === 'APPROVED') return null;
                      return (
                        <Chip tone="bad">
                          {saved.exists
                            ? `No longer approved (${TEST_STATE_LABEL[saved.testStatus ?? 'NONE']})`
                            : 'No longer exists'}
                        </Chip>
                      );
                    })()}
                  </div>
                  <Field label={`Marks for question ${index + 1}`} error={errors.marks?.[index]}>
                    {(id, aria) => (
                      <input
                        id={id}
                        {...aria}
                        className="marks-input"
                        inputMode="decimal"
                        value={item.marks}
                        disabled={questionsLocked}
                        onChange={(e) => setItem(index, { marks: e.target.value })}
                      />
                    )}
                  </Field>
                  {!questionsLocked ? (
                    <div className="builder-buttons">
                      <button
                        type="button"
                        className="button"
                        aria-label={`Move question ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => set('items', moveItem(values.items, index, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="button"
                        aria-label={`Move question ${index + 1} down`}
                        disabled={index === values.items.length - 1}
                        onClick={() => set('items', moveItem(values.items, index, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="button"
                        aria-label={`Remove question ${index + 1}`}
                        onClick={() =>
                          set(
                            'items',
                            values.items.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <p>
            <strong>Total marks: {totalMarks(values.items)}</strong>
          </p>

          {!questionsLocked ? (
            <div className="add-question">
              {questions.isPending ? (
                <Loading label="Loading your questions…" />
              ) : questions.isError ? (
                <ErrorState
                  title="Could not load your questions"
                  message={errorMessage(questions.error)}
                  onRetry={() => void questions.refetch()}
                />
              ) : availableToAdd.length === 0 ? (
                <p className="muted">
                  {values.items.length === 0
                    ? 'You have no approved questions yet. '
                    : 'There are no more approved questions to add. '}
                  <Link to="/teacher/questions">Write or approve one</Link>. Only approved questions
                  can be used in an exam.
                </p>
              ) : (
                <>
                  <Field label="Add a question (approved ones only)">
                    {(id) => (
                      <select id={id} value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
                        <option value="">Choose a question…</option>
                        {availableToAdd.map((q) => (
                          <option key={q.questionId} value={q.questionId}>
                            {q.title}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <button
                    type="button"
                    className="button"
                    disabled={toAdd === ''}
                    onClick={addQuestion}
                  >
                    Add question
                  </button>
                </>
              )}
            </div>
          ) : null}
        </fieldset>

        {exam && dirty && !readOnly && (exam.status === 'READY' || detail?.hasPdf) ? (
          <Notice kind="warning">
            Saving changes sends the exam back to Draft and removes its PDF. Make the PDF again
            afterwards.
          </Notice>
        ) : null}

        {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}

        {!readOnly ? (
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : exam ? 'Save changes' : 'Save exam'}
            </button>
          </div>
        ) : null}
      </form>

      {exam ? (
        <section className="pdf-box">
          <h2>The exam paper (PDF)</h2>
          {!mine ? (
            <p className="muted">Only {exam.createdBy} can make or download the PDF.</p>
          ) : (
            <>
              <p className="muted">
                {detail?.hasPdf
                  ? 'A PDF has been made for this exam.'
                  : 'No PDF has been made yet.'}{' '}
                Making it can take up to half a minute.
              </p>
              {dirty && !readOnly ? (
                <p className="muted">Save your changes first, so the PDF matches them.</p>
              ) : null}
              <div className="actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={makePdf.isPending || (dirty && !readOnly)}
                  onClick={() => makePdf.mutate()}
                >
                  {makePdf.isPending
                    ? 'Making the PDF…'
                    : detail?.hasPdf
                      ? 'Make the PDF again'
                      : 'Generate PDF'}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!detail?.hasPdf || download.isPending || (dirty && !readOnly)}
                  onClick={() => download.mutate()}
                >
                  {download.isPending ? 'Getting the link…' : 'Download PDF'}
                </button>
              </div>
              {makePdf.isError ? <Notice kind="error">{errorMessage(makePdf.error)}</Notice> : null}
              {download.isError ? (
                <Notice kind="error">{errorMessage(download.error)}</Notice>
              ) : null}
            </>
          )}
          {exam.status !== 'DRAFT' ? (
            <p>
              <Link
                to={`/teacher/results?batch=${encodeURIComponent(exam.batchId)}&exam=${encodeURIComponent(exam.examId)}`}
              >
                See the results
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Teacher: build a new exam, or open one to change it, make its PDF and see where it stands. */
export function ExamPage() {
  const { id } = useParams();
  const exam = useExam(id);

  return (
    <section className="page">
      <PageHeader
        title={id ? (exam.data?.exam.title ?? 'Exam') : 'Build an exam'}
        backTo="/teacher/exams"
        backLabel="Back to the exams"
      />
      {!id ? (
        <ExamEditor />
      ) : exam.isPending ? (
        <Loading label="Loading the exam…" />
      ) : exam.isError ? (
        <ErrorState
          title="Could not load the exam"
          message={errorMessage(exam.error)}
          onRetry={() => void exam.refetch()}
        />
      ) : (
        <ExamEditor key={exam.data.exam.examId} detail={exam.data} />
      )}
    </section>
  );
}
