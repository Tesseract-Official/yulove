import {
  ConflictError,
  HttpError,
  mapLimit,
  parseBody,
  publishBody,
  type PublishResponse,
} from '@yulove/shared';
import {
  examStudentsDb,
  examsDb,
  makeActorResolver,
  requireUser,
  totalFor,
} from '@yulove/shared/server';
import { IN_PROGRESS, loadExamStudents } from '../lib/board.js';
import { loadExamInBatch } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * POST /exams/{id}/publish (batch manager): makes results visible to students. If any answer is
 * still QUEUED, TRANSCRIBING or RUNNING it answers 409 with the count, and publishes only when the
 * body says `confirm: true`. Every student's total is worked out again first. Publishing a
 * published exam changes nothing.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['BATCH_MANAGER']);
  const exam = await loadExamInBatch(ctx, pathParam(event, 'id'));
  const body = event.body ? parseBody(publishBody, event) : {};

  if (exam.status === 'PUBLISHED') {
    // A super admin may have published it; the batch manager is not told.
    const publishedBy = await makeActorResolver(ctx.user.role).visible(exam.publishedBy);
    const already: PublishResponse = {
      examId: exam.examId,
      status: 'PUBLISHED',
      alreadyPublished: true,
      publishedBy,
      publishedAt: exam.publishedAt,
    };
    return { status: 200, body: already };
  }
  if (exam.status !== 'READY') {
    throw new ConflictError('Only an exam that is READY can be published');
  }

  const students = await loadExamStudents(exam);

  // Answers of absent students do not count: they score 0 whatever happens to them.
  const inProgress = students
    .filter((s) => !s.absent)
    .flatMap((s) => s.answers)
    .filter((a) => IN_PROGRESS.includes(a.status)).length;
  if (inProgress > 0 && body.confirm !== true) {
    throw new HttpError(
      409,
      'CONFLICT',
      `${inProgress} answer${inProgress === 1 ? ' is' : 's are'} still being graded. Publish anyway?`,
      { inProgress },
    );
  }

  await mapLimit(students, 20, (s) => {
    const total = totalFor(exam, s.answers, s.absent);
    return examStudentsDb.setTotals(exam.examId, s.user.email, total.totalScore, total.maxScore);
  });

  const publishedAt = new Date().toISOString();
  await examsDb.updateExam(exam.examId, {
    status: 'PUBLISHED',
    publishedBy: ctx.user.email,
    publishedAt,
  });

  const published: PublishResponse = {
    examId: exam.examId,
    status: 'PUBLISHED',
    publishedBy: ctx.user.email,
    publishedAt,
    inProgress,
  };
  return { status: 200, body: published };
}

export const handler = apiHandler(handle);
