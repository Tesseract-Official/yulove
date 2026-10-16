import { beforeEach, describe, expect, it } from 'vitest';
import { isQuestionVersionFrozen } from './question-usage.js';
import { FakeDb } from './testing/fake-db.js';
import type { ExamItem } from './types.js';

const db = new FakeDb();

const exam = (examId: string, batchId: string, questions: ExamItem['questions']): ExamItem => ({
  examId,
  batchId,
  title: examId,
  date: '2026-10-24',
  questions,
  status: 'DRAFT',
});

const student = (n: number, batchId = 'A') => ({
  email: `s${n}@college.edu`,
  role: 'STUDENT' as const,
  name: `S${n}`,
  active: true,
  batchId,
  rollNo: `R${n}`,
});

const answer = (examId: string, email: string, questionNumber = 1) => ({
  examStudent: `${examId}#${email}`,
  questionNumber,
  attempt: 1,
  status: 'QUEUED',
});

beforeEach(() => {
  db.reset();
  db.addUser(student(1));
  db.addUser(student(2));
});

describe('isQuestionVersionFrozen', () => {
  it('is false when no exam uses the version', async () => {
    await expect(isQuestionVersionFrozen('q1', 1)).resolves.toBe(false);
  });

  it('is false when an exam uses it but nobody has answered', async () => {
    db.put('Exams', exam('e1', 'A', [{ number: 1, questionId: 'q1', version: 1, marks: 10 }]));
    await expect(isQuestionVersionFrozen('q1', 1)).resolves.toBe(false);
  });

  it('is true as soon as one student has any answer, even only queued', async () => {
    db.put('Exams', exam('e1', 'A', [{ number: 1, questionId: 'q1', version: 1, marks: 10 }]));
    db.put('Answers', answer('e1', 's2@college.edu'));
    await expect(isQuestionVersionFrozen('q1', 1)).resolves.toBe(true);
  });

  it('only counts exams that use this exact version', async () => {
    db.put('Exams', exam('e1', 'A', [{ number: 1, questionId: 'q1', version: 2, marks: 10 }]));
    db.put('Answers', answer('e1', 's1@college.edu'));

    await expect(isQuestionVersionFrozen('q1', 1)).resolves.toBe(false);
    await expect(isQuestionVersionFrozen('q1', 2)).resolves.toBe(true);
  });

  it('ignores answers in other exams and other batches', async () => {
    db.addUser(student(3, 'B'));
    db.put('Exams', exam('e1', 'A', [{ number: 1, questionId: 'q1', version: 1, marks: 10 }]));
    db.put('Exams', exam('e2', 'B', [{ number: 1, questionId: 'q9', version: 1, marks: 10 }]));
    db.put('Answers', answer('e2', 's3@college.edu'));

    await expect(isQuestionVersionFrozen('q1', 1)).resolves.toBe(false);
  });

  it('checks every exam that uses the version', async () => {
    db.addUser(student(3, 'B'));
    db.put('Exams', exam('e1', 'A', [{ number: 1, questionId: 'q1', version: 1, marks: 10 }]));
    db.put('Exams', exam('e2', 'B', [{ number: 2, questionId: 'q1', version: 1, marks: 10 }]));
    db.put('Answers', answer('e2', 's3@college.edu', 2));

    await expect(isQuestionVersionFrozen('q1', 1)).resolves.toBe(true);
  });
});
