import type { QuestionItem, QuestionListResponse, QuestionSummary } from '@yulove/shared';
import { examsDb, questionsDb, requireUser } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** The highest version of each question in the list. */
function latestVersions(items: readonly QuestionItem[]): QuestionItem[] {
  const latest = new Map<string, QuestionItem>();
  for (const item of items) {
    const seen = latest.get(item.questionId);
    if (!seen || item.version > seen.version) latest.set(item.questionId, item);
  }
  return [...latest.values()];
}

/**
 * GET /questions (teacher): the caller's own questions, latest version of each, with the state of
 * its tests and how many exams use it. A super admin sees every teacher's questions.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ['TEACHER']);

  const [items, exams] = await Promise.all([
    user.role === 'SUPER_ADMIN'
      ? questionsDb.listAllQuestions()
      : questionsDb.listQuestionsByTeacher(user.email),
    examsDb.listAllExams(),
  ]);

  const questions: QuestionSummary[] = latestVersions(items)
    .map((q) => ({
      questionId: q.questionId,
      version: q.version,
      title: q.title,
      targetComplexity: q.targetComplexity,
      teacherEmail: q.teacherEmail,
      testStatus: q.testStatus,
      testFailure: q.testFailure,
      usedInExams: exams.filter((exam) =>
        exam.questions.some((ref) => ref.questionId === q.questionId && ref.version === q.version),
      ).length,
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.questionId.localeCompare(b.questionId));

  const body: QuestionListResponse = { questions };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
