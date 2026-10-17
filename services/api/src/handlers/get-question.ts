import type { QuestionDetail, QuestionDetailResponse, QuestionItem } from '@yulove/shared';
import { examsDb, isQuestionVersionFrozen, requireUser } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { loadQuestion } from '../lib/questions.js';

/** What the screens may see of a question: what the teacher wrote and the state of its tests. */
export function toDetail(q: QuestionItem): QuestionDetail {
  return {
    questionId: q.questionId,
    version: q.version,
    teacherEmail: q.teacherEmail,
    title: q.title,
    statement: q.statement,
    ioDescription: q.ioDescription,
    constraints: q.constraints,
    examples: q.examples,
    targetComplexity: q.targetComplexity,
    timeLimitMs: q.timeLimitMs,
    memoryMb: q.memoryMb,
    compareMode: q.compareMode,
    signature: q.signature,
    testStatus: q.testStatus,
    testCount: q.testCount,
    testFailure: q.testFailure,
  };
}

/**
 * GET /questions/{id} (teacher): the latest version, with the state of its tests, whether it is in
 * use (an exam that uses it has answers, so an edit makes a new version) and how many exams use it.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const question = await loadQuestion(ctx, pathParam(event, 'id'));

  const [inUse, exams] = await Promise.all([
    isQuestionVersionFrozen(question.questionId, question.version),
    examsDb.listExamsUsingQuestion(question.questionId, question.version),
  ]);

  const body: QuestionDetailResponse = {
    question: toDetail(question),
    inUse,
    usedInExams: exams.length,
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
