import type { ExamDetailResponse } from '@yulove/shared';
import { examHasAnswers, makeActorResolver, requireUser } from '@yulove/shared/server';
import { loadExamInBatch, loadQuestionVersions } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /exams/{id} (teacher): the exam with each question's title and test state, whether answers
 * exist (the questions and marks are then locked), whether a PDF has been made, and whether the
 * caller may edit it (its creator or a super admin, and only while it is not published). Any
 * teacher of the exam's batch can read it. `createdBy` is left out when a super admin made the exam
 * and the caller is not one.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const exam = await loadExamInBatch(ctx, pathParam(event, 'id'));

  const [versions, hasAnswers] = await Promise.all([
    loadQuestionVersions(exam.questions),
    examHasAnswers(exam.examId, exam.batchId),
  ]);

  const createdBy = await makeActorResolver(ctx.user.role).visible(exam.createdBy);

  const body: ExamDetailResponse = {
    exam: {
      examId: exam.examId,
      batchId: exam.batchId,
      title: exam.title,
      date: exam.date,
      status: exam.status,
      ...(createdBy ? { createdBy } : {}),
      publishedAt: exam.publishedAt,
      questions: versions.map(({ ref, item }) => ({
        number: ref.number,
        questionId: ref.questionId,
        version: ref.version,
        marks: ref.marks,
        title: item?.title,
        testStatus: item?.testStatus,
        exists: item !== undefined,
      })),
    },
    hasAnswers,
    hasPdf: exam.pdfKey !== undefined,
    canEdit:
      exam.status !== 'PUBLISHED' &&
      (ctx.user.role === 'SUPER_ADMIN' || exam.createdBy === ctx.user.email),
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
