import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  ConflictError,
  NotFoundError,
  TESTGEN_FUNCTION_ENV,
  type GenerateTestsResponse,
} from '@yulove/shared';
import { isQuestionVersionFrozen, questionsDb, requireUser } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { loadQuestion } from '../lib/questions.js';

/**
 * POST /questions/{id}/generate-tests (teacher): starts (or redoes) test generation.
 * The work happens in the test-generation Lambda, invoked asynchronously. Allowed in any state,
 * so a stuck GENERATING can be retried, but not on a version that is already in use.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const question = await loadQuestion(ctx, pathParam(event, 'id'));
  const { questionId, version } = question;

  if (await isQuestionVersionFrozen(questionId, version)) {
    throw new ConflictError(
      'This version is used by an exam with submitted answers. Edit the question to create a new version, then generate its tests.',
    );
  }

  const attempt = await questionsDb.beginGeneration(questionId, version);
  if (attempt === undefined) throw new NotFoundError(`No question ${questionId}`);

  const functionName = process.env[TESTGEN_FUNCTION_ENV];
  if (!functionName) throw new Error(`Missing environment variable ${TESTGEN_FUNCTION_ENV}`);

  try {
    const out = await new LambdaClient({}).send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(
          JSON.stringify({ mode: 'generate', questionId, version, attempt }),
        ),
      }),
    );
    if (out.StatusCode !== 202) throw new Error(`Lambda invoke returned ${String(out.StatusCode)}`);
  } catch (error) {
    await questionsDb.markGenerationFailed(
      questionId,
      version,
      attempt,
      'Could not start test generation. Try again.',
    );
    throw error;
  }

  const body: GenerateTestsResponse = { questionId, version, testStatus: 'GENERATING', attempt };
  return { status: 202, body };
}

export const handler = apiHandler(handle);
