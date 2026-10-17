import type {
  BoardStudentRow,
  CellStatus,
  ExamBoardResponse,
  ExamSummary,
  QuestionCell,
} from '@yulove/shared';

export const EXAM_ID = 'exam-1';

export function cell(
  number: number,
  status: CellStatus = 'NOT_SUBMITTED',
  extra: Partial<QuestionCell> = {},
): QuestionCell {
  return {
    number,
    marks: number === 1 ? 10 : 5,
    status,
    score: status === 'GRADED' ? 5 : 0,
    overridden: false,
    ...extra,
  };
}

/** A student with one cell per status given (Q1, Q2, ...). */
export function student(
  email: string,
  name: string,
  rollNo: string,
  statuses: CellStatus[] = ['NOT_SUBMITTED', 'NOT_SUBMITTED', 'NOT_SUBMITTED'],
  extra: Partial<BoardStudentRow> = {},
): BoardStudentRow {
  return {
    email,
    name,
    rollNo,
    active: true,
    absent: false,
    questions: statuses.map((status, i) => cell(i + 1, status)),
    totalScore: 0,
    maxScore: 20,
    ...extra,
  };
}

export function boardOf(
  students: BoardStudentRow[],
  extra: Partial<ExamBoardResponse> = {},
): ExamBoardResponse {
  const counts: ExamBoardResponse['counts'] = {};
  for (const s of students) {
    for (const q of s.questions) counts[q.status] = (counts[q.status] ?? 0) + 1;
  }
  return {
    examId: EXAM_ID,
    title: 'Week 3 test',
    examStatus: 'READY',
    questions: [
      { number: 1, marks: 10 },
      { number: 2, marks: 5 },
      { number: 3, marks: 5 },
    ],
    students,
    counts,
    ...extra,
  };
}

export function examSummary(extra: Partial<ExamSummary> = {}): ExamSummary {
  return {
    examId: EXAM_ID,
    batchId: 'A',
    title: 'Week 3 test',
    date: '2026-10-24',
    status: 'READY',
    questionCount: 3,
    ...extra,
  };
}

export const ASHA = student('s1@college.edu', 'Asha Rao', 'R1');
export const BEN_ABSENT = student('s2@college.edu', 'Ben Rai', 'R2', undefined, { absent: true });
export const CHITRA = student('s3@college.edu', 'Chitra Nair', 'R3', [
  'GRADED',
  'NOT_SUBMITTED',
  'NOT_SUBMITTED',
]);
