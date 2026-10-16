import { ForbiddenError, NotFoundError, type QuestionItem } from '@yulove/shared';
import { questionsDb, type AuthContext } from '@yulove/shared/server';

/**
 * The latest version of a question, if the caller may use it. A teacher sees only their own
 * questions (403 for someone else's); a super admin sees all. Unknown ids are 404.
 */
export async function loadQuestion(ctx: AuthContext, questionId: string): Promise<QuestionItem> {
  const question = await questionsDb.getLatestQuestion(questionId);
  if (!question) throw new NotFoundError(`No question ${questionId}`);
  if (ctx.user.role !== 'SUPER_ADMIN' && question.teacherEmail !== ctx.user.email) {
    throw new ForbiddenError('This question belongs to another teacher');
  }
  return question;
}
