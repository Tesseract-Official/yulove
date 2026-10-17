import {
  ConflictError,
  examBody,
  parseBody,
  ValidationError,
  type ExamItem,
  type SaveExamResponse,
} from '@yulove/shared';
import { examHasAnswers, examsDb, requireUser } from '@yulove/shared/server';
import { loadManagedExam, resolveExamInputs, sameQuestions, toRefs } from '../lib/exams.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * PUT /exams/{id} (teacher): change the title, date, questions or marks.
 *  - a published exam cannot be edited
 *  - the batch cannot change
 *  - once any answer exists, the questions and marks are locked (409); title and date are not
 *  - any change sends the exam back to DRAFT and drops its PDF, which no longer matches
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const exam = await loadManagedExam(ctx, pathParam(event, 'id'));
  const body = parseBody(examBody, event);

  if (exam.status === 'PUBLISHED') throw new ConflictError('A published exam cannot be edited');
  if (body.batchId !== exam.batchId) {
    throw new ValidationError('The batch of an exam cannot be changed; create a new exam instead');
  }

  const questions = toRefs(body.questions);
  const questionsChanged = !sameQuestions(exam.questions, questions);
  const changed = questionsChanged || body.title !== exam.title || body.date !== exam.date;
  if (!changed) {
    const unchanged: SaveExamResponse = { exam, changed: false };
    return { status: 200, body: unchanged };
  }

  if (questionsChanged) {
    if (await examHasAnswers(exam.examId, exam.batchId)) {
      throw new ConflictError(
        'Answers have been submitted for this exam, so its questions and marks are locked',
      );
    }
    await resolveExamInputs(ctx, body);
  }

  await examsDb.updateExam(
    exam.examId,
    { title: body.title, date: body.date, questions, status: 'DRAFT' },
    ['pdfKey'],
  );
  const updated: ExamItem = {
    ...exam,
    title: body.title,
    date: body.date,
    questions,
    status: 'DRAFT',
  };
  delete updated.pdfKey; // the stored exam no longer has it either
  const saved: SaveExamResponse = { exam: updated, changed: true };
  return { status: 200, body: saved };
}

export const handler = apiHandler(handle);
