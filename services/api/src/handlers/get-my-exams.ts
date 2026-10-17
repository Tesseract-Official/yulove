import { mapLimit, type MyExamsResponse, type MyExamSummary } from '@yulove/shared';
import { answersDb, examStudentsDb, examsDb, requireUser, totalFor } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /me/exams (student): the published exams of the student's batch, newest first, with their
 * own total. Nothing about anyone else.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ['STUDENT']);
  if (!user.batchId) {
    const none: MyExamsResponse = { exams: [] };
    return { status: 200, body: none };
  }

  const published = (await examsDb.listExamsByBatch(user.batchId))
    .filter((e) => e.status === 'PUBLISHED')
    .sort((a, b) => b.date.localeCompare(a.date));

  const exams: MyExamSummary[] = await mapLimit(published, 5, async (exam) => {
    const [answers, row] = await Promise.all([
      answersDb.listAnswersForStudent(exam.examId, user.email),
      examStudentsDb.getExamStudent(exam.examId, user.email),
    ]);
    const absent = row?.absent === true;
    const total = totalFor(exam, answers, absent);
    return {
      examId: exam.examId,
      title: exam.title,
      date: exam.date,
      absent,
      totalScore: total.totalScore,
      maxScore: total.maxScore,
    };
  });

  const body: MyExamsResponse = { exams };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
