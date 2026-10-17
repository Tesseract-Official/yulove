import { randomUUID } from 'node:crypto';
import {
  examBody,
  parseBody,
  type ExamItem,
  type ExamStudentItem,
  type SaveExamResponse,
} from '@yulove/shared';
import { examsDb, examStudentsDb, requireUser, usersDb } from '@yulove/shared/server';
import { resolveExamInputs, toRefs } from '../lib/exams.js';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * POST /exams (teacher): an exam for one batch, from approved questions.
 * Then a row for every active student of the batch. Students imported later get theirs on first access.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const body = parseBody(examBody, event);
  await resolveExamInputs(ctx, body);

  const exam: ExamItem = {
    examId: randomUUID(),
    batchId: body.batchId,
    title: body.title,
    date: body.date,
    questions: toRefs(body.questions),
    createdBy: ctx.user.email,
    status: 'DRAFT',
  };
  await examsDb.createExam(exam);

  const rows: ExamStudentItem[] = (await usersDb.listUsersByBatch(body.batchId))
    .filter((u) => u.role === 'STUDENT' && u.active !== false)
    .map((u) => ({ examId: exam.examId, studentEmail: u.email, absent: false }));

  // The exam is saved, so a problem writing the rows is not fatal: the rest are created on first access.
  const pending = await examStudentsDb.putExamStudents(rows).then(
    (result) => result.unwritten.length,
    (error: unknown) => {
      console.error(`Could not write the student rows of exam ${exam.examId}`, error);
      return rows.length;
    },
  );

  const response: SaveExamResponse = {
    exam,
    studentRows: { created: rows.length - pending, pending },
  };
  return { status: 201, body: response };
}

export const handler = apiHandler(handle);
