import type {
  BoardStudentRow,
  CellStatus,
  ExamBoardResponse,
  ExamDetailResponse,
  ExamResultsResponse,
  ExamSummary,
  QuestionCell,
  QuestionDetail,
  QuestionDetailResponse,
  QuestionSummary,
  QuestionTestsResponse,
  ResultCell,
  ResultStudentRow,
  TestPreview,
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
    createdBy: 'teacher@college.edu',
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

// ---- Teacher screens ----

export const TEACHER_EMAIL = 'teacher@college.edu';

export function questionDetail(extra: Partial<QuestionDetail> = {}): QuestionDetail {
  return {
    questionId: 'q1',
    version: 1,
    teacherEmail: TEACHER_EMAIL,
    title: 'Two Sum',
    statement: 'Write a function called twoSum that finds two numbers that add up to the target.',
    ioDescription: 'Input: nums and target. Output: two indexes.',
    constraints: '2 <= n <= 100000',
    examples: [{ input: '{"nums":[2,7],"target":9}', output: '[0,1]', explanation: '2 + 7 = 9' }],
    targetComplexity: 'O(n)',
    timeLimitMs: 2000,
    memoryMb: 256,
    compareMode: 'EXACT',
    ...extra,
  };
}

export function questionResponse(
  extra: Partial<QuestionDetail> = {},
  flags: { inUse?: boolean; usedInExams?: number } = {},
): QuestionDetailResponse {
  return {
    question: questionDetail(extra),
    inUse: flags.inUse ?? false,
    usedInExams: flags.usedInExams ?? 0,
  };
}

export function questionSummary(extra: Partial<QuestionSummary> = {}): QuestionSummary {
  return {
    questionId: 'q1',
    version: 1,
    title: 'Two Sum',
    targetComplexity: 'O(n)',
    teacherEmail: TEACHER_EMAIL,
    usedInExams: 0,
    ...extra,
  };
}

export const SIGNATURE = {
  name: 'twoSum',
  parameters: [
    { name: 'nums', type: 'int[]' },
    { name: 'target', type: 'int' },
  ],
  returnType: 'int[]',
};

/** The ten tests: seven small, then three large. */
export function testPreviews(
  extra: (index: number) => Partial<TestPreview> = () => ({}),
): TestPreview[] {
  return Array.from({ length: 10 }, (_, index) => ({
    index,
    kind: index < 7 ? ('small' as const) : ('large' as const),
    input: `{"nums":[${index},2],"target":${index + 2}}`,
    expected: '[0,1]',
    truncated: false,
    ...extra(index),
  }));
}

export function testsResponse(
  status: QuestionTestsResponse['testStatus'],
  extra: Partial<QuestionTestsResponse> = {},
): QuestionTestsResponse {
  const ready = status === 'NEEDS_REVIEW' || status === 'APPROVED';
  return {
    questionId: 'q1',
    version: 1,
    testStatus: status,
    signature: ready ? SIGNATURE : null,
    ...(ready ? { tests: testPreviews() } : {}),
    ...extra,
  };
}

export function examDetail(
  extra: Partial<ExamDetailResponse['exam']> = {},
  flags: Partial<Omit<ExamDetailResponse, 'exam'>> = {},
): ExamDetailResponse {
  return {
    exam: {
      examId: EXAM_ID,
      batchId: 'A',
      title: 'Week 3 test',
      date: '2026-10-24',
      status: 'DRAFT',
      createdBy: TEACHER_EMAIL,
      publishedAt: undefined,
      questions: [
        {
          number: 1,
          questionId: 'q1',
          version: 1,
          marks: 10,
          title: 'Two Sum',
          testStatus: 'APPROVED',
          exists: true,
        },
        {
          number: 2,
          questionId: 'q2',
          version: 1,
          marks: 5,
          title: 'Valid Parentheses',
          testStatus: 'APPROVED',
          exists: true,
        },
      ],
      ...extra,
    },
    hasAnswers: false,
    hasPdf: false,
    canEdit: true,
    ...flags,
  };
}

export function resultCell(
  number: number,
  status: ResultCell['status'] = 'GRADED',
  extra: Partial<ResultCell> = {},
): ResultCell {
  return {
    number,
    marks: number === 1 ? 10 : 5,
    status,
    score: status === 'GRADED' ? (number === 1 ? 7.5 : 5) : 0,
    overridden: false,
    failedToGrade: status === 'FAILED_TO_GRADE',
    ...extra,
  };
}

export function resultRow(
  email: string,
  name: string,
  rollNo: string,
  cells: ResultCell[],
  extra: Partial<ResultStudentRow> = {},
): ResultStudentRow {
  return {
    email,
    name,
    rollNo,
    active: true,
    absent: false,
    questions: cells,
    totalScore: cells.reduce((sum, c) => sum + c.score, 0),
    maxScore: 15,
    failedToGrade: cells.filter((c) => c.failedToGrade).length,
    ...extra,
  };
}

export function resultsOf(
  students: ResultStudentRow[],
  extra: Partial<ExamResultsResponse> = {},
): ExamResultsResponse {
  return {
    examId: EXAM_ID,
    title: 'Week 3 test',
    date: '2026-10-24',
    examStatus: 'READY',
    maxScore: 15,
    questions: [
      { number: 1, marks: 10 },
      { number: 2, marks: 5 },
    ],
    students,
    ...extra,
  };
}
