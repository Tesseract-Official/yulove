import {
  computeQuestionScore,
  normaliseEmail,
  overrideVisibleTo,
  type AnswerStatus,
  type BoardStudentRow,
  type CellStatus,
  type ExamAnswerSummary,
  type ExamItem,
  type ExamQuestionRef,
  type QuestionCell,
  type Role,
  type UserItem,
} from '@yulove/shared';
import { answersDb, examStudentsDb, totalFor, usersDb } from '@yulove/shared/server';

/** A student of the exam with everything stored about them. */
export interface ExamStudentView {
  user: UserItem;
  absent: boolean;
  answers: ExamAnswerSummary[];
}

/**
 * Every student of the exam: the batch's students who are active, plus anyone who has a row for
 * the exam. Sorted by roll number. All the exam's answers come from one paginated query on the
 * Answers `byExam` index, however many students there are.
 */
export async function loadExamStudents(exam: ExamItem): Promise<ExamStudentView[]> {
  const [users, rows, allAnswers] = await Promise.all([
    usersDb.listUsersByBatch(exam.batchId),
    examStudentsDb.listExamStudents(exam.examId),
    answersDb.listAnswersByExam(exam.examId),
  ]);
  const answersBy = new Map<string, ExamAnswerSummary[]>();
  for (const answer of allAnswers) {
    const email = normaliseEmail(answer.studentEmail);
    const list = answersBy.get(email);
    if (list) list.push(answer);
    else answersBy.set(email, [answer]);
  }
  const absentBy = new Map(rows.map((r) => [r.studentEmail, r.absent === true]));

  const students = users
    .filter((u) => u.role === 'STUDENT' && (u.active !== false || absentBy.has(u.email)))
    .sort(
      (a, b) =>
        (a.rollNo ?? '').localeCompare(b.rollNo ?? '', undefined, { numeric: true }) ||
        a.email.localeCompare(b.email),
    );

  return students.map((user) => ({
    user,
    absent: absentBy.get(user.email) === true,
    answers: answersBy.get(user.email) ?? [],
  }));
}

export function questionCell(
  ref: Pick<ExamQuestionRef, 'number' | 'marks'>,
  answer: ExamAnswerSummary | undefined,
  absent: boolean,
  viewer: Role,
): QuestionCell {
  return {
    number: ref.number,
    marks: ref.marks,
    status: (answer?.status ?? 'NOT_SUBMITTED') satisfies CellStatus,
    ...(answer?.failReason ? { failReason: answer.failReason } : {}),
    ...(answer?.failDetail ? { failDetail: answer.failDetail } : {}),
    score: computeQuestionScore(ref.marks, answer, absent),
    // A super admin's override counts in the score but is not marked for anyone else.
    overridden: overrideVisibleTo(viewer, answer?.override) !== undefined && !absent,
  };
}

/** One student's row: a cell per question and the total. */
export function studentRow(
  exam: ExamItem,
  student: ExamStudentView,
  viewer: Role,
): BoardStudentRow {
  const byNumber = new Map(student.answers.map((a) => [a.questionNumber, a]));
  const total = totalFor(exam, student.answers, student.absent);
  return {
    email: student.user.email,
    name: student.user.name,
    rollNo: student.user.rollNo,
    active: student.user.active !== false,
    absent: student.absent,
    questions: exam.questions.map((q) =>
      questionCell(q, byNumber.get(q.number), student.absent, viewer),
    ),
    totalScore: total.totalScore,
    maxScore: total.maxScore,
  };
}

/** Answers that are still on their way through the pipeline. */
export const IN_PROGRESS: readonly AnswerStatus[] = ['QUEUED', 'TRANSCRIBING', 'RUNNING'];
