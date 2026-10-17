import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  COMPARE_MODES,
  testsStillValid,
  type QuestionBody,
  type QuestionDetailResponse,
  type SaveQuestionResponse,
} from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { ErrorState, Loading } from '../../ui/states.js';
import {
  EMPTY_EXAMPLE,
  EMPTY_QUESTION_FORM,
  MAX_EXAMPLES,
  contentFromForm,
  formFromQuestion,
  validateQuestionForm,
  type QuestionFormErrors,
  type QuestionFormValues,
} from '../common/questionForm.js';
import { keys, useQuestion } from '../common/hooks.js';
import { COMPARE_MODE_LABEL, plural } from '../common/labels.js';
import { Field, Notice, PageHeader } from '../common/ui.js';

interface FormProps {
  /** The question being edited; undefined when writing a new one. */
  existing?: QuestionDetailResponse;
}

function QuestionForm({ existing }: FormProps) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = existing?.question;

  const [values, setValues] = useState<QuestionFormValues>(() =>
    detail ? formFromQuestion(detail) : EMPTY_QUESTION_FORM,
  );
  const [errors, setErrors] = useState<QuestionFormErrors>({});
  const [saved, setSaved] = useState<string | undefined>();

  const set = <K extends keyof QuestionFormValues>(key: K, value: QuestionFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setExample = (index: number, patch: Partial<QuestionFormValues['examples'][number]>) =>
    set(
      'examples',
      values.examples.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    );

  // Changing any of these throws the generated tests away (the server applies the same rule).
  const discardsTests = useMemo(() => {
    if (!detail || detail.testStatus === undefined) return false;
    const next = contentFromForm(values);
    return next !== undefined && !testsStillValid(detail, next);
  }, [detail, values]);

  const save = useMutation({
    mutationFn: async (body: QuestionBody): Promise<SaveQuestionResponse> =>
      detail
        ? api.updateQuestion(detail.questionId, body)
        : { ...(await api.createQuestion(body)), newVersion: false, testsKept: false },
    meta: { errorToast: false },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.questions });
      const question = result.question;
      if (!question) return;
      await queryClient.invalidateQueries({ queryKey: keys.question(question.questionId) });
      await queryClient.invalidateQueries({ queryKey: keys.questionTests(question.questionId) });

      const next = `/teacher/questions/${question.questionId}/tests`;
      if (!detail) {
        navigate(next, { state: { notice: 'Question saved. Next: generate its tests.' } });
        return;
      }
      const { newVersion, testsKept } = result;
      if (!testsKept) {
        navigate(next, {
          state: {
            notice: `Saved${newVersion ? ` as version ${question.version}` : ''}. The old tests were removed because the question changed. Generate them again and approve them.`,
          },
        });
        return;
      }
      setSaved(
        newVersion
          ? `Saved as version ${question.version}. The tests were kept.`
          : 'Saved. The tests were kept.',
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(undefined);
    const result = validateQuestionForm(values);
    if (!result.ok) return setErrors(result.errors);
    setErrors({});
    save.mutate(result.body);
  };

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form className="form form-wide" onSubmit={submit} noValidate>
      {detail && existing?.inUse ? (
        <Notice kind="warning">
          This question is used in an exam that already has answers. Saving creates a new version
          (version {detail.version + 1}). The exam keeps using version {detail.version}.
        </Notice>
      ) : detail && existing && existing.usedInExams > 0 ? (
        <Notice kind="info">
          This question is used in {plural(existing.usedInExams, 'exam')} that{' '}
          {existing.usedInExams === 1 ? 'has' : 'have'} no answers yet. Your changes apply to{' '}
          {existing.usedInExams === 1 ? 'it' : 'them'}.
        </Notice>
      ) : null}
      {discardsTests ? (
        <Notice kind="warning">
          Changing the statement, the input and output description, the constraints, the limits, the
          time complexity or the way answers are compared means the tests must be generated and
          approved again. Changing only the title or the examples keeps them.
        </Notice>
      ) : null}
      {hasErrors ? (
        <Notice kind="error">Some answers need fixing. They are marked below.</Notice>
      ) : null}

      <Field label="Title" error={errors.title}>
        {(id, aria) => (
          <input
            id={id}
            {...aria}
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
          />
        )}
      </Field>

      <Field
        label="Statement"
        hint="Describe the problem. Say which function students should write, for example “Write a function called twoSum …”. The tests are made for that function."
        error={errors.statement}
      >
        {(id, aria) => (
          <textarea
            id={id}
            {...aria}
            rows={8}
            value={values.statement}
            onChange={(e) => set('statement', e.target.value)}
          />
        )}
      </Field>

      <Field
        label="What the input and output look like"
        hint="For example: “Input: an array of integers and a target. Output: the two indexes.”"
        error={errors.ioDescription}
      >
        {(id, aria) => (
          <textarea
            id={id}
            {...aria}
            rows={3}
            value={values.ioDescription}
            onChange={(e) => set('ioDescription', e.target.value)}
          />
        )}
      </Field>

      <Field label="Constraints" hint="For example: “2 ≤ n ≤ 100000”." error={errors.constraints}>
        {(id, aria) => (
          <textarea
            id={id}
            {...aria}
            rows={3}
            value={values.constraints}
            onChange={(e) => set('constraints', e.target.value)}
          />
        )}
      </Field>

      <fieldset className="examples">
        <legend>Examples (1 to {MAX_EXAMPLES})</legend>
        {errors.examples ? <p className="field-error">{errors.examples}</p> : null}
        {values.examples.map((example, index) => (
          <div key={index} className="example-box">
            <h3>Example {index + 1}</h3>
            <Field label={`Example ${index + 1} input`} error={errors.example?.[index]?.input}>
              {(id, aria) => (
                <textarea
                  id={id}
                  {...aria}
                  rows={2}
                  value={example.input}
                  onChange={(e) => setExample(index, { input: e.target.value })}
                />
              )}
            </Field>
            <Field label={`Example ${index + 1} output`} error={errors.example?.[index]?.output}>
              {(id, aria) => (
                <textarea
                  id={id}
                  {...aria}
                  rows={2}
                  value={example.output}
                  onChange={(e) => setExample(index, { output: e.target.value })}
                />
              )}
            </Field>
            <Field label={`Example ${index + 1} explanation (optional)`}>
              {(id) => (
                <input
                  id={id}
                  value={example.explanation}
                  onChange={(e) => setExample(index, { explanation: e.target.value })}
                />
              )}
            </Field>
            {values.examples.length > 1 ? (
              <button
                type="button"
                className="button"
                onClick={() =>
                  set(
                    'examples',
                    values.examples.filter((_, i) => i !== index),
                  )
                }
              >
                Remove example {index + 1}
              </button>
            ) : null}
          </div>
        ))}
        {values.examples.length < MAX_EXAMPLES ? (
          <button
            type="button"
            className="button"
            onClick={() => set('examples', [...values.examples, { ...EMPTY_EXAMPLE }])}
          >
            Add another example
          </button>
        ) : null}
      </fieldset>

      <Field
        label="Time complexity students must meet"
        hint="For example O(n) or O(n log n). A correct answer that is slower than this scores 0."
        error={errors.targetComplexity}
      >
        {(id, aria) => (
          <input
            id={id}
            {...aria}
            value={values.targetComplexity}
            onChange={(e) => set('targetComplexity', e.target.value)}
          />
        )}
      </Field>

      <div className="field-row">
        <Field
          label="Time limit (seconds)"
          hint="For one test, in C++ or Go. Java and Python get more time."
          error={errors.timeLimitSeconds}
        >
          {(id, aria) => (
            <input
              id={id}
              {...aria}
              inputMode="decimal"
              value={values.timeLimitSeconds}
              onChange={(e) => set('timeLimitSeconds', e.target.value)}
            />
          )}
        </Field>
        <Field label="Memory limit (MB)" error={errors.memoryMb}>
          {(id, aria) => (
            <input
              id={id}
              {...aria}
              inputMode="numeric"
              value={values.memoryMb}
              onChange={(e) => set('memoryMb', e.target.value)}
            />
          )}
        </Field>
      </div>

      <Field label="How an answer is compared with the expected output">
        {(id) => (
          <select
            id={id}
            value={values.compareMode}
            onChange={(e) =>
              set('compareMode', e.target.value as QuestionFormValues['compareMode'])
            }
          >
            {COMPARE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {COMPARE_MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        )}
      </Field>

      {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      {saved ? <Notice kind="success">{saved}</Notice> : null}

      <div className="actions">
        <button type="submit" className="button button-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : detail ? 'Save changes' : 'Save question'}
        </button>
      </div>
    </form>
  );
}

/** Teacher: write a new question, or edit one. */
export function QuestionFormPage() {
  const { id } = useParams();
  const question = useQuestion(id);

  return (
    <section className="page">
      <PageHeader
        title={id ? 'Edit question' : 'Write a question'}
        intro={id && question.data ? `Version ${question.data.question.version}` : undefined}
        backTo="/teacher/questions"
        backLabel="Back to the questions"
      />
      {!id ? (
        <QuestionForm />
      ) : question.isPending ? (
        <Loading label="Loading the question…" />
      ) : question.isError ? (
        <ErrorState
          title="Could not load the question"
          message={errorMessage(question.error)}
          onRetry={() => void question.refetch()}
        />
      ) : (
        <QuestionForm
          key={`${question.data.question.questionId}-${question.data.question.version}`}
          existing={question.data}
        />
      )}
    </section>
  );
}
