import { beforeEach, describe, expect, it } from 'vitest';
import { examStudentsDb } from './server.js';
import { answersByNumber, recomputeExamTotal, totalFor } from './exam-totals.js';
import { FakeDb } from './testing/index.js';
import type { AnswerItem, ExamStudentItem } from './types.js';

const db = new FakeDb();
const exam = {
  examId: 'e1',
  questions: [
    { number: 1, marks: 10 },
    { number: 2, marks: 5 },
  ],
};
const EMAIL = 's@college.edu';

const answer = (questionNumber: number, extra: Partial<AnswerItem> = {}): AnswerItem => ({
  examStudent: `e1#${EMAIL}`,
  questionNumber,
  attempt: 1,
  status: 'GRADED',
  testsPassed: 5,
  testsTotal: 10,
  meetsComplexity: true,
  ...extra,
});
const row = () => db.get<ExamStudentItem>('ExamStudents', { examId: 'e1', studentEmail: EMAIL });

beforeEach(() => {
  db.reset();
});

describe('recomputeExamTotal', () => {
  it('sums the displayed scores and stores them, creating the row', async () => {
    db.put('Answers', answer(1)); // 5/10 of 10 = 5
    db.put('Answers', answer(2, { testsPassed: 10 })); // 5

    expect(await recomputeExamTotal(exam, EMAIL)).toEqual({ totalScore: 10, maxScore: 15 });
    expect(row()).toEqual({
      examId: 'e1',
      studentEmail: EMAIL,
      absent: false,
      totalScore: 10,
      maxScore: 15,
    });
  });

  it('counts a question with no answer as 0 and a failed one as 0', async () => {
    db.put('Answers', answer(1, { status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE' }));
    expect(await recomputeExamTotal(exam, EMAIL)).toEqual({ totalScore: 0, maxScore: 15 });
  });

  it('lets an override replace the formula score', async () => {
    db.put('Answers', answer(1, { override: { score: 9, reason: 'r', by: 'a', at: 't' } }));
    expect((await recomputeExamTotal(exam, EMAIL)).totalScore).toBe(9);
  });

  it('is 0 for an absent student, and comes back when unmarked', async () => {
    db.put('Answers', answer(1));
    await examStudentsDb.setAbsent('e1', EMAIL, true);
    expect(await recomputeExamTotal(exam, EMAIL)).toEqual({ totalScore: 0, maxScore: 15 });
    expect(row()).toMatchObject({ absent: true, totalScore: 0 });

    await examStudentsDb.setAbsent('e1', EMAIL, false);
    expect(await recomputeExamTotal(exam, EMAIL)).toEqual({ totalScore: 5, maxScore: 15 });
  });
});

describe('totalFor and answersByNumber', () => {
  it('work on answers already in hand', () => {
    const answers = [answer(1), answer(2, { testsPassed: 0 })];
    expect(totalFor(exam, answers, false)).toEqual({ totalScore: 5, maxScore: 15 });
    expect(totalFor(exam, answers, true)).toEqual({ totalScore: 0, maxScore: 15 });
    expect([...answersByNumber(answers).keys()]).toEqual([1, 2]);
  });
});
