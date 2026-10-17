import { requireUser } from '@yulove/shared/server';
import { loadExamStudents, studentRow } from '../lib/board.js';
import { loadExamInBatch } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /exams/{id}/results (teacher): every student's name, roll number, score on each question
 * and total. Absent students are marked absent with every score 0; a question that could not be
 * graded says so (and why) instead of looking like a plain 0.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const exam = await loadExamInBatch(ctx, pathParam(event, 'id'));

  const students = (await loadExamStudents(exam)).map((s) => {
    const row = studentRow(exam, s);
    return {
      ...row,
      questions: row.questions.map((q) => ({
        ...q,
        failedToGrade: q.status === 'FAILED_TO_GRADE',
      })),
      failedToGrade: row.questions.filter((q) => q.status === 'FAILED_TO_GRADE').length,
    };
  });

  return {
    status: 200,
    body: {
      examId: exam.examId,
      title: exam.title,
      date: exam.date,
      examStatus: exam.status,
      maxScore: students[0]?.maxScore ?? exam.questions.reduce((sum, q) => sum + q.marks, 0),
      questions: exam.questions.map((q) => ({ number: q.number, marks: q.marks })),
      students,
    },
  };
}

export const handler = apiHandler(handle);
