import {
  parseBody,
  pickDefined,
  questionBody,
  testsStillValid,
  type QuestionItem,
} from '@yulove/shared';
import { isQuestionVersionFrozen, questionsDb, requireUser } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { loadQuestion } from '../lib/questions.js';

/** Test material that carries over to a new version when only the title or examples changed. */
const INHERITED = ['testStatus', 'testCount', 'testsKey', 'signature'] as const;

/**
 * PUT /questions/{id} (teacher): edits the latest version.
 *
 * - If an exam that uses this version has any answer submitted, the version is frozen and the
 *   edit creates version + 1 (201).
 * - Otherwise it is edited in place (200).
 * - Changing only the title or examples keeps the tests; changing anything else throws the
 *   tests, signature and status away, so the teacher regenerates and approves again.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const current = await loadQuestion(ctx, pathParam(event, 'id'));
  const body = parseBody(questionBody, event);

  const keepTests = testsStillValid(current, body);
  const frozen = await isQuestionVersionFrozen(current.questionId, current.version);

  if (frozen) {
    const inherited =
      keepTests && (current.testStatus === 'NEEDS_REVIEW' || current.testStatus === 'APPROVED')
        ? pickDefined(current, INHERITED)
        : {};
    const next: QuestionItem = {
      questionId: current.questionId,
      version: current.version + 1,
      teacherEmail: current.teacherEmail,
      ...body,
      ...inherited,
    };
    await questionsDb.createQuestion(next); // 409 if someone created this version first
    return { status: 201, body: { question: next, newVersion: true, testsKept: keepTests } };
  }

  const updated = keepTests
    ? await questionsDb.updateQuestion(current.questionId, current.version, body)
    : await questionsDb.resetQuestionTests(current.questionId, current.version, body);
  const question = updated
    ? await questionsDb.getQuestion(current.questionId, current.version)
    : undefined;

  return {
    status: 200,
    body: { question, newVersion: false, testsKept: keepTests },
  };
}

export const handler = apiHandler(handle);
