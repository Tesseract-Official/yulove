import { listAnswersForStudent } from './db/answers.js';
import { getExamStudent, setTotals } from './db/exam-students.js';
import { computeExamTotal, type ExamTotal, type ScorableAnswer } from './scoring.js';
import type { AnswerItem, ExamQuestionRef } from './types.js';

/** What a total needs to know about an exam. */
export interface TotalExam {
  examId: string;
  questions: Pick<ExamQuestionRef, 'number' | 'marks'>[];
}

/** A student's answers keyed by question number. */
export function answersByNumber(answers: readonly AnswerItem[]): Map<number, AnswerItem> {
  return new Map(answers.map((a) => [a.questionNumber, a]));
}

/** The total for one student from answers already in hand. */
export function totalFor(
  exam: Pick<TotalExam, 'questions'>,
  answers: readonly ScorableAnswerWithNumber[],
  absent: boolean,
): ExamTotal {
  return computeExamTotal(
    exam.questions,
    new Map(answers.map((a) => [a.questionNumber, a])),
    absent,
  );
}

export type ScorableAnswerWithNumber = ScorableAnswer & { questionNumber: number };

/**
 * Recomputes a student's total for an exam from their answers and absent flag (override beats the
 * formula score, absent beats everything) and stores it in ExamStudents. Returns it.
 */
export async function recomputeExamTotal(
  exam: TotalExam,
  studentEmail: string,
): Promise<ExamTotal> {
  const [answers, row] = await Promise.all([
    listAnswersForStudent(exam.examId, studentEmail),
    getExamStudent(exam.examId, studentEmail),
  ]);
  const total = totalFor(exam, answers, row?.absent === true);
  await setTotals(exam.examId, studentEmail, total.totalScore, total.maxScore);
  return total;
}
