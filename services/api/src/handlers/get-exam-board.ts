import { requireUser } from '@yulove/shared/server';
import { loadExamStudents, studentRow } from '../lib/board.js';
import { loadExamInBatch } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /exams/{id}/answers (batch manager, teacher): the status board. Every student of the exam
 * with each question's status, failure reason, score and the absent flag, plus how many answers
 * are in each status.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER', 'TEACHER']);
  const exam = await loadExamInBatch(ctx, pathParam(event, 'id'));

  const students = (await loadExamStudents(exam)).map((s) => studentRow(exam, s));

  const counts: Record<string, number> = {};
  for (const student of students) {
    for (const cell of student.questions) counts[cell.status] = (counts[cell.status] ?? 0) + 1;
  }

  return {
    status: 200,
    body: {
      examId: exam.examId,
      title: exam.title,
      examStatus: exam.status,
      questions: exam.questions.map((q) => ({ number: q.number, marks: q.marks })),
      students,
      counts,
    },
  };
}

export const handler = apiHandler(handle);
