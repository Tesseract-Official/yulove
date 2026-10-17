import {
  questionBody,
  type CompareMode,
  type QuestionBody,
  type QuestionContent,
  type QuestionDetail,
} from '@yulove/shared';

export interface ExampleFormValues {
  input: string;
  output: string;
  explanation: string;
}

/** What the question form holds: text as typed, and the time limit in seconds. */
export interface QuestionFormValues {
  title: string;
  statement: string;
  ioDescription: string;
  constraints: string;
  examples: ExampleFormValues[];
  targetComplexity: string;
  timeLimitSeconds: string;
  memoryMb: string;
  compareMode: CompareMode;
}

export const MAX_EXAMPLES = 3;

export const EMPTY_EXAMPLE: ExampleFormValues = { input: '', output: '', explanation: '' };

export const EMPTY_QUESTION_FORM: QuestionFormValues = {
  title: '',
  statement: '',
  ioDescription: '',
  constraints: '',
  examples: [{ ...EMPTY_EXAMPLE }],
  targetComplexity: '',
  timeLimitSeconds: '2',
  memoryMb: '256',
  compareMode: 'EXACT',
};

/** The form values for a question that already exists. */
export function formFromQuestion(question: QuestionDetail): QuestionFormValues {
  return {
    title: question.title,
    statement: question.statement,
    ioDescription: question.ioDescription,
    constraints: question.constraints,
    examples: question.examples.map((e) => ({
      input: e.input,
      output: e.output,
      explanation: e.explanation ?? '',
    })),
    targetComplexity: question.targetComplexity,
    timeLimitSeconds: String(question.timeLimitMs / 1000),
    memoryMb: String(question.memoryMb),
    compareMode: question.compareMode,
  };
}

export interface QuestionFormErrors {
  title?: string;
  statement?: string;
  ioDescription?: string;
  constraints?: string;
  /** Problems with the list of examples as a whole. */
  examples?: string;
  /** Problems inside one example, by position. */
  example?: Array<{ input?: string; output?: string } | undefined>;
  targetComplexity?: string;
  timeLimitSeconds?: string;
  memoryMb?: string;
}

export type QuestionFormResult =
  { ok: true; body: QuestionBody } | { ok: false; errors: QuestionFormErrors };

/** A number typed as text: undefined when it is not one. Accepts a comma as the decimal mark. */
function parseNumber(text: string): number | undefined {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '' || !/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** The time limit in whole milliseconds, or undefined when the text is not a usable number. */
export function secondsToMs(text: string): number | undefined {
  const seconds = parseNumber(text);
  if (seconds === undefined) return undefined;
  const ms = Math.round(seconds * 1000);
  return ms >= 1 ? ms : undefined;
}

function textProblem(value: string, name: string, max: number): string | undefined {
  const text = value.trim();
  if (text === '') return `Type ${name}.`;
  if (text.length > max) return `This is too long: at most ${max.toLocaleString('en')} characters.`;
  return undefined;
}

/** Checks the form with plain messages. On success, gives the body to send to the API. */
export function validateQuestionForm(values: QuestionFormValues): QuestionFormResult {
  const errors: QuestionFormErrors = {};

  const title = textProblem(values.title, 'a title for the question', 200);
  if (title) errors.title = title;
  const statement = textProblem(values.statement, 'the question statement', 20_000);
  if (statement) errors.statement = statement;
  const io = textProblem(values.ioDescription, 'what the input and output look like', 5_000);
  if (io) errors.ioDescription = io;
  const constraints = textProblem(values.constraints, 'the constraints', 5_000);
  if (constraints) errors.constraints = constraints;
  const complexity = textProblem(
    values.targetComplexity,
    'the time complexity students must meet, for example O(n)',
    100,
  );
  if (complexity) errors.targetComplexity = complexity;

  if (values.examples.length < 1) errors.examples = 'Add at least one example.';
  if (values.examples.length > MAX_EXAMPLES) {
    errors.examples = `Use at most ${MAX_EXAMPLES} examples.`;
  }
  const exampleErrors = values.examples.map((example) => {
    const problem: { input?: string; output?: string } = {};
    if (example.input.trim() === '') problem.input = 'Type the example input.';
    if (example.output.trim() === '') problem.output = 'Type what the program should print.';
    return Object.keys(problem).length > 0 ? problem : undefined;
  });
  if (exampleErrors.some(Boolean)) errors.example = exampleErrors;

  const timeLimitMs = secondsToMs(values.timeLimitSeconds);
  if (timeLimitMs === undefined) {
    errors.timeLimitSeconds = 'Type the time limit in seconds, for example 2 or 1.5.';
  }
  const memory = parseNumber(values.memoryMb);
  if (memory === undefined || !Number.isInteger(memory) || memory < 1) {
    errors.memoryMb = 'Type the memory limit in whole megabytes, for example 256.';
  }

  if (Object.keys(errors).length > 0 || timeLimitMs === undefined || memory === undefined) {
    return { ok: false, errors };
  }

  const candidate = {
    title: values.title.trim(),
    statement: values.statement.trim(),
    ioDescription: values.ioDescription.trim(),
    constraints: values.constraints.trim(),
    examples: values.examples.map((e) => {
      const explanation = e.explanation.trim();
      return {
        input: e.input,
        output: e.output,
        ...(explanation ? { explanation } : {}),
      };
    }),
    targetComplexity: values.targetComplexity.trim(),
    timeLimitMs,
    memoryMb: memory,
    compareMode: values.compareMode,
  };
  // The same check the API applies, as a last guard.
  const parsed = questionBody.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: { title: 'Some details are not valid. Check the form and try again.' },
    };
  }
  return { ok: true, body: parsed.data };
}

/**
 * The question's content as the form currently holds it, for working out whether the tests would
 * be thrown away. Undefined while the numbers are not valid.
 */
export function contentFromForm(values: QuestionFormValues): QuestionContent | undefined {
  const timeLimitMs = secondsToMs(values.timeLimitSeconds);
  const memory = parseNumber(values.memoryMb);
  if (timeLimitMs === undefined || memory === undefined) return undefined;
  return {
    title: values.title.trim(),
    statement: values.statement.trim(),
    ioDescription: values.ioDescription.trim(),
    constraints: values.constraints.trim(),
    examples: [],
    targetComplexity: values.targetComplexity.trim(),
    timeLimitMs,
    memoryMb: memory,
    compareMode: values.compareMode,
  };
}
