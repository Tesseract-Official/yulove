import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type BatchItem,
  type ExamBody,
  type ExamItem,
  type ExamQuestionRef,
  type QuestionItem,
} from '@yulove/shared';
import { batchesDb, examsDb, questionsDb, type AuthContext } from '@yulove/shared/server';
import { mapLimit } from '@yulove/shared';

export interface ResolvedQuestion {
  ref: ExamQuestionRef;
  item: QuestionItem;
}

const refKey = (ref: Pick<ExamQuestionRef, 'questionId' | 'version'>) =>
  `${ref.questionId} v${ref.version}`;

/**
 * Checks everything an exam depends on, and returns the batch and the question versions.
 *  - the caller may use the batch (403) and it exists (422)
 *  - every question version exists (422), belongs to the caller unless they are a super admin
 *    (403) and is APPROVED (422)
 */
export async function resolveExamInputs(
  ctx: AuthContext,
  body: Pick<ExamBody, 'batchId' | 'questions'>,
): Promise<{ batch: BatchItem; questions: ResolvedQuestion[] }> {
  ctx.assertBatchAccess(body.batchId);
  const batch = await batchesDb.getBatch(body.batchId);
  if (!batch) throw new ValidationError(`Unknown batch ${body.batchId}`, { batchId: body.batchId });

  const questions = await loadQuestionVersions(body.questions);

  const missing = questions.filter((q) => !q.item).map((q) => refKey(q.ref));
  if (missing.length > 0) {
    throw new ValidationError(`Unknown questions: ${missing.join(', ')}`, { missing });
  }
  const found = questions as ResolvedQuestion[];

  if (ctx.user.role !== 'SUPER_ADMIN') {
    const foreign = found.filter((q) => q.item.teacherEmail !== ctx.user.email);
    if (foreign.length > 0) {
      throw new ForbiddenError(
        `These questions belong to another teacher: ${foreign.map((q) => refKey(q.ref)).join(', ')}`,
      );
    }
  }

  const notApproved = found
    .filter((q) => q.item.testStatus !== 'APPROVED')
    .map((q) => refKey(q.ref));
  if (notApproved.length > 0) {
    throw new ValidationError(
      `Only approved questions can be used. Not approved: ${notApproved.join(', ')}`,
      {
        notApproved,
      },
    );
  }
  return { batch, questions: found };
}

/** Each question version of the list (undefined `item` for one that does not exist). */
export async function loadQuestionVersions(
  refs: readonly ExamQuestionRef[],
): Promise<Array<{ ref: ExamQuestionRef; item: QuestionItem | undefined }>> {
  const items = await mapLimit(refs, 10, (ref) =>
    questionsDb.getQuestion(ref.questionId, ref.version),
  );
  return refs.map((ref, i) => ({ ref, item: items[i] }));
}

/**
 * Whether the caller may manage this exam: any super admin, or the teacher who created it while
 * still assigned to its batch. This is the one rule for "an exam a teacher may edit": editing,
 * making the PDF, handling its appeals and overriding its scores all use it.
 */
export function mayManageExam(ctx: AuthContext, exam: ExamItem): boolean {
  if (ctx.user.role === 'SUPER_ADMIN') return true;
  return (
    ctx.user.role === 'TEACHER' &&
    exam.createdBy === ctx.user.email &&
    ctx.canAccessBatch(exam.batchId)
  );
}

/** The exam, if the caller may manage it (see mayManageExam): else 404 or 403. */
export async function loadManagedExam(ctx: AuthContext, examId: string): Promise<ExamItem> {
  const exam = await examsDb.getExam(examId);
  if (!exam) throw new NotFoundError(`No exam ${examId}`);
  if (ctx.user.role !== 'SUPER_ADMIN') {
    if (exam.createdBy !== ctx.user.email)
      throw new ForbiddenError('This exam was created by another teacher');
    ctx.assertBatchAccess(exam.batchId);
  }
  return exam;
}

/**
 * Whether the caller may review this exam's results: handle its appeals, override scores and read
 * the score history. Any super admin, or any teacher assigned to the exam's batch right now (not
 * only the teacher who made the exam). Editing the exam itself stays with mayManageExam.
 */
export function mayReviewExam(ctx: AuthContext, exam: ExamItem): boolean {
  if (ctx.user.role === 'SUPER_ADMIN') return true;
  return ctx.user.role === 'TEACHER' && ctx.canAccessBatch(exam.batchId);
}

/** The exam, if the caller may review it (see mayReviewExam): else 404, or 403 when not in its batch. */
export async function loadReviewableExam(ctx: AuthContext, examId: string): Promise<ExamItem> {
  const exam = await examsDb.getExam(examId);
  if (!exam) throw new NotFoundError(`No exam ${examId}`);
  if (!mayReviewExam(ctx, exam)) throw new ForbiddenError('You are not assigned to this batch');
  return exam;
}

/** Same questions, in the same order, with the same marks? */
export function sameQuestions(
  a: readonly ExamQuestionRef[],
  b: readonly ExamQuestionRef[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (q, i) =>
        q.number === b[i]?.number &&
        q.questionId === b[i]?.questionId &&
        q.version === b[i]?.version &&
        q.marks === b[i]?.marks,
    )
  );
}

/** Just the fields stored in the exam for each question. */
export const toRefs = (questions: readonly ExamQuestionRef[]): ExamQuestionRef[] =>
  questions.map(({ number, questionId, version, marks }) => ({
    number,
    questionId,
    version,
    marks,
  }));

/**
 * An exam the caller may work with through its batch: it exists (404) and the caller is assigned
 * to its batch (403). Super admins pass. Unlike loadManagedExam, any teacher or batch manager of
 * the batch may use it, not only the teacher who made it.
 */
export async function loadExamInBatch(ctx: AuthContext, examId: string): Promise<ExamItem> {
  const exam = await examsDb.getExam(examId);
  if (!exam) throw new NotFoundError(`No exam ${examId}`);
  ctx.assertBatchAccess(exam.batchId);
  return exam;
}
