import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUESTION_FORM,
  contentFromForm,
  formFromQuestion,
  secondsToMs,
  validateQuestionForm,
  type QuestionFormValues,
} from './questionForm.js';
import {
  isRealDate,
  moveItem,
  totalMarks,
  validateExamForm,
  type ExamFormValues,
} from './examForm.js';
import { questionDetail } from '../../test/fixtures.js';

const validQuestion = (): QuestionFormValues => ({
  ...formFromQuestion(questionDetail()),
});

describe('validateQuestionForm', () => {
  it('turns a complete form into the request body, with the time limit in milliseconds', () => {
    const result = validateQuestionForm(validQuestion());

    expect(result).toEqual({
      ok: true,
      body: {
        title: 'Two Sum',
        statement:
          'Write a function called twoSum that finds two numbers that add up to the target.',
        ioDescription: 'Input: nums and target. Output: two indexes.',
        constraints: '2 <= n <= 100000',
        examples: [
          { input: '{"nums":[2,7],"target":9}', output: '[0,1]', explanation: '2 + 7 = 9' },
        ],
        targetComplexity: 'O(n)',
        timeLimitMs: 2000,
        memoryMb: 256,
        compareMode: 'EXACT',
      },
    });
  });

  it('asks for every required field in plain words', () => {
    const result = validateQuestionForm({
      ...EMPTY_QUESTION_FORM,
      timeLimitSeconds: '',
      memoryMb: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toMatchObject({
      title: 'Type a title for the question.',
      statement: 'Type the question statement.',
      ioDescription: 'Type what the input and output look like.',
      constraints: 'Type the constraints.',
      targetComplexity: expect.stringContaining('Type the time complexity'),
      timeLimitSeconds: 'Type the time limit in seconds, for example 2 or 1.5.',
      memoryMb: 'Type the memory limit in whole megabytes, for example 256.',
    });
    expect(result.errors.example?.[0]).toEqual({
      input: 'Type the example input.',
      output: 'Type what the program should print.',
    });
  });

  it('treats text of only spaces as empty', () => {
    const result = validateQuestionForm({ ...validQuestion(), title: '   ' });

    expect(result.ok).toBe(false);
  });

  it('keeps to the API’s length limits', () => {
    const result = validateQuestionForm({
      ...validQuestion(),
      title: 'x'.repeat(201),
      statement: 'x'.repeat(20_001),
      targetComplexity: 'x'.repeat(101),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toContain('at most 200 characters');
    expect(result.errors.statement).toContain('at most 20,000 characters');
    expect(result.errors.targetComplexity).toContain('at most 100 characters');
  });

  it('needs 1 to 3 examples', () => {
    expect(validateQuestionForm({ ...validQuestion(), examples: [] })).toMatchObject({
      ok: false,
      errors: { examples: 'Add at least one example.' },
    });
    const four = Array.from({ length: 4 }, () => ({ input: '1', output: '2', explanation: '' }));
    expect(validateQuestionForm({ ...validQuestion(), examples: four })).toMatchObject({
      ok: false,
      errors: { examples: 'Use at most 3 examples.' },
    });
  });

  it('marks which example has the problem, and leaves the explanation optional', () => {
    const values = {
      ...validQuestion(),
      examples: [
        { input: '1', output: '2', explanation: '' },
        { input: '', output: '3', explanation: '' },
      ],
    };

    const result = validateQuestionForm(values);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.example?.[0]).toBeUndefined();
    expect(result.errors.example?.[1]).toEqual({ input: 'Type the example input.' });
  });

  it('leaves the explanation out of the body when it is blank', () => {
    const result = validateQuestionForm({
      ...validQuestion(),
      examples: [{ input: '1', output: '2', explanation: '  ' }],
    });

    expect(result.ok && result.body.examples[0]).toEqual({ input: '1', output: '2' });
  });

  it.each(['0', '-1', 'abc', '1e3', '0.0001'])('rejects the time limit "%s"', (text) => {
    const result = validateQuestionForm({ ...validQuestion(), timeLimitSeconds: text });

    expect(result.ok).toBe(false);
  });

  it.each(['0', '1.5', '-5', 'abc', ''])('rejects the memory limit "%s"', (text) => {
    expect(validateQuestionForm({ ...validQuestion(), memoryMb: text }).ok).toBe(false);
  });

  it('accepts a decimal time limit, with a comma too', () => {
    const dot = validateQuestionForm({ ...validQuestion(), timeLimitSeconds: '1.5' });
    const comma = validateQuestionForm({ ...validQuestion(), timeLimitSeconds: '0,5' });

    expect(dot.ok && dot.body.timeLimitMs).toBe(1500);
    expect(comma.ok && comma.body.timeLimitMs).toBe(500);
  });
});

describe('secondsToMs', () => {
  it('rounds to whole milliseconds and refuses nonsense', () => {
    expect(secondsToMs('2')).toBe(2000);
    expect(secondsToMs('0.0015')).toBe(2);
    expect(secondsToMs('')).toBeUndefined();
    expect(secondsToMs('two')).toBeUndefined();
  });
});

describe('form helpers for a question that exists', () => {
  it('shows the stored time limit in seconds', () => {
    expect(formFromQuestion(questionDetail({ timeLimitMs: 1500 })).timeLimitSeconds).toBe('1.5');
  });

  it('gives the content that decides whether the tests stay valid', () => {
    const content = contentFromForm(validQuestion());

    expect(content).toMatchObject({ timeLimitMs: 2000, memoryMb: 256, compareMode: 'EXACT' });
    expect(contentFromForm({ ...validQuestion(), memoryMb: 'x' })).toBeUndefined();
  });
});

const validExam = (): ExamFormValues => ({
  batchId: 'A',
  title: 'Week 4 test',
  date: '2026-10-31',
  items: [
    { questionId: 'q1', version: 1, title: 'Two Sum', marks: '10' },
    { questionId: 'q2', version: 2, title: 'Parentheses', marks: '2.5' },
  ],
});

describe('validateExamForm', () => {
  it('numbers the questions 1 to n and sends the marks as numbers', () => {
    expect(validateExamForm(validExam())).toEqual({
      ok: true,
      body: {
        batchId: 'A',
        title: 'Week 4 test',
        date: '2026-10-31',
        questions: [
          { number: 1, questionId: 'q1', version: 1, marks: 10 },
          { number: 2, questionId: 'q2', version: 2, marks: 2.5 },
        ],
      },
    });
  });

  it('asks for the batch, a title, a date and a question', () => {
    const result = validateExamForm({ batchId: '', title: ' ', date: '', items: [] });

    expect(result).toEqual({
      ok: false,
      errors: {
        batchId: 'Choose the batch that will write this exam.',
        title: 'Type a title for the exam.',
        date: 'Choose the date of the exam.',
        questions: 'Add at least one question.',
      },
    });
  });

  it.each(['2026-02-30', '31/10/2026', '2026-13-01'])('rejects the date "%s"', (date) => {
    const result = validateExamForm({ ...validExam(), date });

    expect(result).toMatchObject({ ok: false, errors: { date: 'That is not a valid date.' } });
  });

  it('marks which question has bad marks', () => {
    const values = validExam();
    values.items[1] = { ...values.items[1]!, marks: '0' };
    values.items[0] = { ...values.items[0]!, marks: 'ten' };

    const result = validateExamForm(values);

    expect(result).toMatchObject({
      ok: false,
      errors: {
        marks: {
          0: 'Type the marks as a number above 0.',
          1: 'Type the marks as a number above 0.',
        },
      },
    });
  });

  it('allows at most 50 questions', () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      questionId: `q${i}`,
      version: 1,
      title: `Q${i}`,
      marks: '1',
    }));

    expect(validateExamForm({ ...validExam(), items })).toMatchObject({
      ok: false,
      errors: { questions: 'An exam can have at most 50 questions.' },
    });
  });

  it('limits the title to 200 characters', () => {
    expect(validateExamForm({ ...validExam(), title: 'x'.repeat(201) })).toMatchObject({
      ok: false,
      errors: { title: expect.stringContaining('200') },
    });
  });
});

describe('exam helpers', () => {
  it('recognises only real dates', () => {
    expect(isRealDate('2026-10-24')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
  });

  it('moves an item up or down, and not past the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('adds up the marks that are numbers', () => {
    expect(totalMarks(validExam().items)).toBe(12.5);
    expect(totalMarks([{ questionId: 'q', version: 1, title: 't', marks: 'x' }])).toBe(0);
  });
});
