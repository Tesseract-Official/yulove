import type { AnswerItem, ExamStudentItem } from '@yulove/shared';
import type { FakeDb } from '@yulove/shared/testing';
import { userOf } from './events.js';
import { EXAM_ID, examItem, seedExamWorld } from './exams.js';

export const MANAGER = 'batch-manager@college.edu';
export const TEACHER_A = 'teacher@college.edu';
export const MANAGER_B = 'manager-b@college.edu';
export const TEACHER_B = 'teacher-b@college.edu';

/** A graded answer: 5 of 10 tests on question 1 (10 marks) is a score of 5. */
export function answerItem(
  email: string,
  questionNumber: number,
  extra: Partial<AnswerItem> = {},
): AnswerItem {
  return {
    examStudent: `${EXAM_ID}#${email}`,
    questionNumber,
    attempt: 1,
    status: 'GRADED',
    imageKey: `answers/${EXAM_ID}/R1/q${questionNumber}.jpg`,
    language: 'python',
    rawTranscription: 'raw',
    correctedCode: 'code',
    fixes: ['added a colon'],
    estimatedComplexity: 'O(n)',
    meetsComplexity: true,
    testsPassed: 5,
    testsTotal: 10,
    score: questionNumber === 1 ? 5 : 2.5,
    verdicts: [{ index: 0, kind: 'small', verdict: 'AC' }],
    ...extra,
  };
}

export function examStudentRow(
  email: string,
  extra: Partial<ExamStudentItem> = {},
): ExamStudentItem {
  return { examId: EXAM_ID, studentEmail: email, absent: false, ...extra };
}

/**
 * The exam world with a READY exam for batch A (questions 1 and 2, 10 and 5 marks), staff for
 * batches A and B, and no answers yet. Students: s1 (R1), s2 (R2), s3 (R3), inactive (R9) in
 * batch A, other-batch (R8) in batch B.
 */
export function seedGradingWorld(db: FakeDb): void {
  seedExamWorld(db);
  db.put('Exams', examItem({ status: 'READY' }));
  db.addUser(userOf('BATCH_MANAGER', { email: MANAGER_B, batchIds: ['B'] }));
  db.addUser(userOf('TEACHER', { email: TEACHER_B, batchIds: ['B'] }));
}
