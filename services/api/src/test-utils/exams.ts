import type { ExamItem, ExamBody } from '@yulove/shared';
import type { FakeDb } from '@yulove/shared/testing';
import { userOf } from './events.js';
import { OTHER_TEACHER, questionItem, seedPeople, signature, TEACHER } from './questions.js';

export const EXAM_ID = 'exam-1';

/** A request body for POST /exams and PUT /exams/{id}. */
export function examRequest(overrides: Partial<ExamBody> = {}): ExamBody {
  return {
    batchId: 'A',
    title: 'Week 3 test',
    date: '2026-10-24',
    questions: [
      { number: 1, questionId: 'q1', version: 1, marks: 10 },
      { number: 2, questionId: 'q2', version: 1, marks: 5 },
    ],
    ...overrides,
  };
}

/** An exam as stored, created by TEACHER for batch A. */
export function examItem(overrides: Partial<ExamItem> = {}): ExamItem {
  return {
    examId: EXAM_ID,
    batchId: 'A',
    title: 'Week 3 test',
    date: '2026-10-24',
    questions: examRequest().questions,
    createdBy: TEACHER,
    status: 'DRAFT',
    ...overrides,
  };
}

/** Batches A and B, every role, four students in A (one inactive) and some questions. */
export function seedExamWorld(db: FakeDb): void {
  db.addBatch('A', 'Batch A');
  db.addBatch('B', 'Batch B');
  seedPeople(db); // super admin, two teachers (batch A), a batch manager, student s1 in A
  for (const n of [2, 3]) {
    db.addUser(userOf('STUDENT', { email: `s${n}@college.edu`, batchId: 'A', rollNo: `R${n}` }));
  }
  db.addUser(
    userOf('STUDENT', { email: 'inactive@college.edu', batchId: 'A', rollNo: 'R9', active: false }),
  );
  db.addUser(userOf('STUDENT', { email: 'other-batch@college.edu', batchId: 'B', rollNo: 'R8' }));

  const approved = { testStatus: 'APPROVED' as const, signature, testAttempt: 1 };
  db.put('Questions', questionItem({ questionId: 'q1', title: 'Two Sum', ...approved }));
  db.put('Questions', questionItem({ questionId: 'q2', title: 'Valid Parentheses', ...approved }));
  db.put(
    'Questions',
    questionItem({
      questionId: 'q3',
      title: 'Still Reviewing',
      testStatus: 'NEEDS_REVIEW',
      signature,
    }),
  );
  db.put('Questions', questionItem({ questionId: 'q4', title: 'Not Generated' }));
  db.put(
    'Questions',
    questionItem({
      questionId: 'q5',
      title: 'Someone Else',
      teacherEmail: OTHER_TEACHER,
      ...approved,
    }),
  );
}
