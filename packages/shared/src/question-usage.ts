import { mapLimit } from './concurrency.js';
import { hasAnyAnswer } from './db/answers.js';
import { listExamStudents } from './db/exam-students.js';
import { listExamsUsingQuestion } from './db/exams.js';
import { listUsersByBatch } from './db/users.js';

const CHECK_CONCURRENCY = 25;

/**
 * A question version is frozen once any exam that uses it has an answer submitted (any status).
 * Frozen versions are never edited or regenerated; edits create a new version instead.
 *
 * Answers are looked up per student of each exam's batch, 25 at a time, stopping at the first hit.
 */
export async function isQuestionVersionFrozen(
  questionId: string,
  version: number,
): Promise<boolean> {
  const exams = await listExamsUsingQuestion(questionId, version);
  for (const exam of exams) {
    const students = (await listUsersByBatch(exam.batchId)).filter((u) => u.role === 'STUDENT');
    for (let i = 0; i < students.length; i += CHECK_CONCURRENCY) {
      const chunk = students.slice(i, i + CHECK_CONCURRENCY);
      const found = await mapLimit(chunk, CHECK_CONCURRENCY, (s) =>
        hasAnyAnswer(exam.examId, s.email),
      );
      if (found.some(Boolean)) return true;
    }
  }
  return false;
}

/**
 * Does any student have an answer (any status) in this exam? Looks at the students who have a row
 * for the exam and at the students of the exam's batch, 25 at a time, and stops at the first hit.
 * An exam with answers has its questions and marks locked.
 */
export async function examHasAnswers(examId: string, batchId: string): Promise<boolean> {
  const [rows, students] = await Promise.all([listExamStudents(examId), listUsersByBatch(batchId)]);
  const emails = [
    ...new Set([
      ...rows.map((r) => r.studentEmail),
      ...students.filter((u) => u.role === 'STUDENT').map((u) => u.email),
    ]),
  ];
  for (let i = 0; i < emails.length; i += CHECK_CONCURRENCY) {
    const chunk = emails.slice(i, i + CHECK_CONCURRENCY);
    const found = await mapLimit(chunk, CHECK_CONCURRENCY, (email) => hasAnyAnswer(examId, email));
    if (found.some(Boolean)) return true;
  }
  return false;
}
