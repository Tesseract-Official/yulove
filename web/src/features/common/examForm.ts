import { MAX_EXAM_QUESTIONS, examBody, type ExamBody } from '@yulove/shared';

/** One question in the exam being built. `marks` is text, as typed. */
export interface ExamFormItem {
  questionId: string;
  version: number;
  title: string;
  marks: string;
}

export interface ExamFormValues {
  batchId: string;
  title: string;
  /** YYYY-MM-DD, as a date input gives it. */
  date: string;
  items: ExamFormItem[];
}

export const DEFAULT_MARKS = '10';

export interface ExamFormErrors {
  batchId?: string;
  title?: string;
  date?: string;
  questions?: string;
  /** A problem with the marks of the question at this position. */
  marks?: Record<number, string>;
}

export type ExamFormResult = { ok: true; body: ExamBody } | { ok: false; errors: ExamFormErrors };

/** True for a real calendar date written YYYY-MM-DD. */
export function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function parseMarks(text: string): number | undefined {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Checks the form with plain messages. On success, gives the body to send, numbered 1 to n. */
export function validateExamForm(values: ExamFormValues): ExamFormResult {
  const errors: ExamFormErrors = {};

  if (values.batchId === '') errors.batchId = 'Choose the batch that will write this exam.';
  const title = values.title.trim();
  if (title === '') errors.title = 'Type a title for the exam.';
  else if (title.length > 200) errors.title = 'The title is too long (200 characters at most).';
  if (values.date === '') errors.date = 'Choose the date of the exam.';
  else if (!isRealDate(values.date)) errors.date = 'That is not a valid date.';

  if (values.items.length === 0) errors.questions = 'Add at least one question.';
  else if (values.items.length > MAX_EXAM_QUESTIONS) {
    errors.questions = `An exam can have at most ${MAX_EXAM_QUESTIONS} questions.`;
  }

  const marks: Record<number, string> = {};
  const parsed = values.items.map((item, index) => {
    const value = parseMarks(item.marks);
    if (value === undefined) marks[index] = 'Type the marks as a number above 0.';
    return value;
  });
  if (Object.keys(marks).length > 0) errors.marks = marks;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const result = examBody.safeParse({
    batchId: values.batchId,
    title,
    date: values.date,
    questions: values.items.map((item, index) => ({
      number: index + 1,
      questionId: item.questionId,
      version: item.version,
      marks: parsed[index],
    })),
  });
  if (!result.success) {
    return {
      ok: false,
      errors: { title: 'Some details are not valid. Check the form and try again.' },
    };
  }
  return { ok: true, body: result.data };
}

/** The list with the item at `index` moved by `delta` places (the list itself if it cannot move). */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** The marks that add up to the exam's total, ignoring anything that is not a number. */
export function totalMarks(items: readonly ExamFormItem[]): number {
  return items.reduce((sum, item) => sum + (parseMarks(item.marks) ?? 0), 0);
}
