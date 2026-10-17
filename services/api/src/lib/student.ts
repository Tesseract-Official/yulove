import { NotFoundError, type ExamItem, type UserItem } from '@yulove/shared';
import { examsDb } from '@yulove/shared/server';

/**
 * An exam a student may see: it exists, belongs to the student's own batch and is PUBLISHED.
 * Anything else is a plain 404, so a student cannot tell an unpublished exam, an exam of another
 * batch and a made-up id apart.
 */
export async function loadPublishedExam(student: UserItem, examId: string): Promise<ExamItem> {
  const exam = await examsDb.getExam(examId);
  if (
    !exam ||
    exam.status !== 'PUBLISHED' ||
    !student.batchId ||
    exam.batchId !== student.batchId
  ) {
    throw new NotFoundError(`No exam ${examId}`);
  }
  return exam;
}
