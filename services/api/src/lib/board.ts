import {
  computeQuestionScore,
  mapLimit,
  type AnswerItem,
  type AnswerStatus,
  type BoardStudentRow,
  type CellStatus,
  type ExamItem,
  type ExamQuestionRef,
  type QuestionCell,
  type UserItem,
} from '@yulove/shared';
import { answersDb, examStudentsDb, totalFor, usersDb } from '@yulove/shared/server';

const CONCURRENCY = 20;

/** A student of the exam with everything stored about them. */
export interface ExamStudentView {
  user: UserItem;
  absent: boolean;
  answers: AnswerItem[];
}

/**
 * Every student of the exam: the batch's students who are active, plus anyone who has a row for
 * the exam. Sorted by roll number. Answers are read per student, a few at a time.
 */
export async function loadExamStudents(exam: ExamItem): Promise<ExamStudentView[]> {
  const [users, rows] = await Promise.all([
    usersDb.listUsersByBatch(exam.batchId),
    examStudentsDb.listExamStudents(exam.examId),
  ]);
  const absentBy = new Map(rows.map((r) => [r.studentEmail, r.absent === true]));

  const students = users
    .filter((u) => u.role === 'STUDENT' && (u.active !== false || absentBy.has(u.email)))
    .sort(
      (a, b) =>
        (a.rollNo ?? '').localeCompare(b.rollNo ?? '', undefined, { numeric: true }) ||
        a.email.localeCompare(b.email),
    );

  return mapLimit(students, CONCURRENCY, async (user) => ({
    user,
    absent: absentBy.get(user.email) === true,
    answers: await answersDb.listAnswersForStudent(exam.examId, user.email),
  }));
}

export function questionCell(
  ref: Pick<ExamQuestionRef, 'number' | 'marks'>,
  answer: AnswerItem | undefined,
  absent: boolean,
): QuestionCell {
  return {
    number: ref.number,
    marks: ref.marks,
    status: (answer?.status ?? 'NOT_SUBMITTED') satisfies CellStatus,
    ...(answer?.failReason ? { failReason: answer.failReason } : {}),
    ...(answer?.failDetail ? { failDetail: answer.failDetail } : {}),
    score: computeQuestionScore(ref.marks, answer, absent),
    overridden: answer?.override !== undefined && !absent,
  };
}

/** One student's row: a cell per question and the total. */
export function studentRow(exam: ExamItem, student: ExamStudentView): BoardStudentRow {
  const byNumber = new Map(student.answers.map((a) => [a.questionNumber, a]));
  const total = totalFor(exam, student.answers, student.absent);
  return {
    email: student.user.email,
    name: student.user.name,
    rollNo: student.user.rollNo,
    active: student.user.active !== false,
    absent: student.absent,
    questions: exam.questions.map((q) => questionCell(q, byNumber.get(q.number), student.absent)),
    totalScore: total.totalScore,
    maxScore: total.maxScore,
  };
}

/** Answers that are still on their way through the pipeline. */
export const IN_PROGRESS: readonly AnswerStatus[] = ['QUEUED', 'TRANSCRIBING', 'RUNNING'];
