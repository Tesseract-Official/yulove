import { describe, expect, it } from 'vitest';
import {
  assignBatchesBody,
  closeAppealBody,
  createAppealBody,
  createBatchBody,
  createStaffBody,
  examBody,
  importStudentsBody,
  overrideBody,
  questionBody,
  requestUploadUrlBody,
  setAbsentBody,
  submitAnswerBody,
} from './schemas.js';

const validQuestion = {
  title: 'Two Sum',
  statement: 'Find two numbers that add to the target.',
  ioDescription: 'Input: array and target. Output: indices.',
  constraints: '1 <= n <= 1e5',
  examples: [{ input: '[2,7] 9', output: '[0,1]' }],
  targetComplexity: 'O(n)',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
};

const validExam = {
  batchId: 'CSE-A',
  title: 'Week 3',
  date: '2026-10-24',
  questions: [
    { number: 1, questionId: 'q1', version: 1, marks: 10 },
    { number: 2, questionId: 'q2', version: 1, marks: 5 },
  ],
};

describe('request body schemas', () => {
  it('createStaff normalises the email and defaults batchIds', () => {
    const parsed = createStaffBody.parse({
      email: ' Teach@College.EDU ',
      name: 'T',
      role: 'TEACHER',
    });
    expect(parsed).toEqual({
      email: 'teach@college.edu',
      name: 'T',
      role: 'TEACHER',
      batchIds: [],
    });
  });

  it.each([
    ['super admin as a staff role', { email: 'a@b.co', name: 'x', role: 'SUPER_ADMIN' }],
    ['student as a staff role', { email: 'a@b.co', name: 'x', role: 'STUDENT' }],
    ['a bad email', { email: 'nope', name: 'x', role: 'TEACHER' }],
    ['an empty name', { email: 'a@b.co', name: ' ', role: 'TEACHER' }],
  ])('createStaff rejects %s', (_label, body) => {
    expect(createStaffBody.safeParse(body).success).toBe(false);
  });

  it('assignBatches needs an array', () => {
    expect(assignBatchesBody.safeParse({ batchIds: ['A', 'B'] }).success).toBe(true);
    expect(assignBatchesBody.safeParse({ batchIds: 'A' }).success).toBe(false);
  });

  it('createBatch limits the id to a safe slug', () => {
    expect(createBatchBody.safeParse({ batchId: '2026-A', name: 'CSE A' }).success).toBe(true);
    expect(createBatchBody.safeParse({ batchId: 'has space', name: 'x' }).success).toBe(false);
    expect(createBatchBody.safeParse({ batchId: 'a#b', name: 'x' }).success).toBe(false);
  });

  it('override needs a reason; a null score clears', () => {
    expect(overrideBody.safeParse({ score: 7.5, reason: 'Misread' }).success).toBe(true);
    expect(overrideBody.safeParse({ score: null, reason: 'Admin error' }).success).toBe(true);
    expect(overrideBody.safeParse({ score: 7, reason: ' ' }).success).toBe(false);
    expect(overrideBody.safeParse({ score: -1, reason: 'x' }).success).toBe(false);
    expect(overrideBody.safeParse({ score: 7 }).success).toBe(false);
  });

  it('importStudents takes raw CSV text', () => {
    expect(importStudentsBody.safeParse({ csv: 'name,email\nA,a@b.co' }).success).toBe(true);
    expect(importStudentsBody.safeParse({ csv: '' }).success).toBe(false);
    expect(importStudentsBody.safeParse({ rows: [] }).success).toBe(false);
  });

  it('upload-url only accepts JPEG', () => {
    const body = { examId: 'e1', studentEmail: 'S@College.edu', questionNumber: 1 };
    expect(requestUploadUrlBody.parse({ ...body, contentType: 'image/jpeg' }).studentEmail).toBe(
      's@college.edu',
    );
    expect(requestUploadUrlBody.safeParse({ ...body, contentType: 'image/png' }).success).toBe(
      false,
    );
  });

  it('submit needs a positive integer question number', () => {
    const body = { examId: 'e1', studentEmail: 's@college.edu' };
    expect(submitAnswerBody.safeParse({ ...body, questionNumber: 1 }).success).toBe(true);
    expect(submitAnswerBody.safeParse({ ...body, questionNumber: 0 }).success).toBe(false);
    expect(submitAnswerBody.safeParse({ ...body, questionNumber: 1.5 }).success).toBe(false);
  });

  it('absent needs a boolean', () => {
    expect(setAbsentBody.safeParse({ absent: true }).success).toBe(true);
    expect(setAbsentBody.safeParse({ absent: 'yes' }).success).toBe(false);
  });

  describe('question', () => {
    it('accepts a full question', () => {
      expect(questionBody.safeParse(validQuestion).success).toBe(true);
    });

    it.each([
      ['no examples', { examples: [] }],
      [
        'four examples',
        { examples: Array.from({ length: 4 }, () => ({ input: 'a', output: 'b' })) },
      ],
      ['an unknown compare mode', { compareMode: 'LOOSE' }],
      ['a zero time limit', { timeLimitMs: 0 }],
      ['a fractional memory limit', { memoryMb: 1.5 }],
    ])('rejects %s', (_label, change) => {
      expect(questionBody.safeParse({ ...validQuestion, ...change }).success).toBe(false);
    });
  });

  describe('exam', () => {
    it('accepts a full exam', () => {
      expect(examBody.safeParse(validExam).success).toBe(true);
    });

    it.each([
      ['no questions', { questions: [] }],
      [
        'duplicate question numbers',
        {
          questions: [
            { number: 1, questionId: 'q1', version: 1, marks: 10 },
            { number: 1, questionId: 'q2', version: 1, marks: 5 },
          ],
        },
      ],
      ['zero marks', { questions: [{ number: 1, questionId: 'q1', version: 1, marks: 0 }] }],
      ['a bad date', { date: '24/10/2026' }],
      [
        'numbers that skip one',
        {
          questions: [
            { number: 1, questionId: 'q1', version: 1, marks: 10 },
            { number: 3, questionId: 'q2', version: 1, marks: 5 },
          ],
        },
      ],
      [
        'numbers out of order',
        {
          questions: [
            { number: 2, questionId: 'q1', version: 1, marks: 10 },
            { number: 1, questionId: 'q2', version: 1, marks: 5 },
          ],
        },
      ],
      [
        'numbers that do not start at 1',
        { questions: [{ number: 2, questionId: 'q1', version: 1, marks: 10 }] },
      ],
      [
        'more than 50 questions',
        {
          questions: Array.from({ length: 51 }, (_, i) => ({
            number: i + 1,
            questionId: `q${i}`,
            version: 1,
            marks: 1,
          })),
        },
      ],
      ['marks below zero', { questions: [{ number: 1, questionId: 'q1', version: 1, marks: -1 }] }],
    ])('rejects %s', (_label, change) => {
      expect(examBody.safeParse({ ...validExam, ...change }).success).toBe(false);
    });
  });

  it('closeAppeal needs the CLOSED status and a note', () => {
    expect(closeAppealBody.safeParse({ status: 'CLOSED', note: 'Re-checked' }).success).toBe(true);
    expect(closeAppealBody.safeParse({ status: 'OPEN', note: 'x' }).success).toBe(false);
    expect(closeAppealBody.safeParse({ status: 'CLOSED', note: '' }).success).toBe(false);
  });

  it('createAppeal takes no student email (it comes from the JWT)', () => {
    const parsed = createAppealBody.parse({
      examId: 'e1',
      questionNumber: 2,
      message: 'Please recheck',
      studentEmail: 'attacker@college.edu',
    });
    expect(parsed).not.toHaveProperty('studentEmail');
  });
});

describe('appeal bodies', () => {
  it('a message is required, trimmed and at most 1000 characters', () => {
    const body = (message: string) =>
      createAppealBody.safeParse({ examId: 'e1', questionNumber: 1, message });
    expect(body('x'.repeat(1000)).success).toBe(true);
    expect(body('x'.repeat(1001)).success).toBe(false);
    expect(body('   ').success).toBe(false);
    expect(body('').success).toBe(false);
    expect(
      createAppealBody.parse({ examId: 'e1', questionNumber: 1, message: '  hi  ' }).message,
    ).toBe('hi');
  });

  it('PUT /appeals takes a closing note or a rerun', async () => {
    const { updateAppealBody } = await import('./schemas.js');
    expect(updateAppealBody.safeParse({ status: 'CLOSED', note: 'Checked' }).success).toBe(true);
    expect(updateAppealBody.safeParse({ status: 'CLOSED' }).success).toBe(false);
    expect(updateAppealBody.safeParse({ status: 'RERUN' }).success).toBe(true);
    expect(updateAppealBody.safeParse({ status: 'RERUN', note: 'Re-checking' }).success).toBe(true);
    expect(updateAppealBody.safeParse({ status: 'OPEN' }).success).toBe(false);
  });
});
