import { randomUUID } from 'node:crypto';
import { parseBody, questionBody, type QuestionItem } from '@yulove/shared';
import { questionsDb, requireUser } from '@yulove/shared/server';
import { apiHandler, type ApiEvent, type ApiResult } from '../lib/http.js';

/** POST /questions (teacher): creates version 1. No tests exist until generate-tests is called. */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ['TEACHER']);
  const body = parseBody(questionBody, event);

  const question: QuestionItem = {
    questionId: randomUUID(),
    version: 1,
    teacherEmail: user.email,
    ...body,
  };
  await questionsDb.createQuestion(question);
  return { status: 201, body: { question } };
}

export const handler = apiHandler(handle);
