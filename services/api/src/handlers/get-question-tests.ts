import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BUCKET_ENV,
  questionKeys,
  testsFileSchema,
  type QuestionItem,
  type QuestionTestsResponse,
  type TestPreview,
} from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';
import { loadQuestion } from '../lib/questions.js';

/** Each input and output is cut to this many characters, so large tests cannot overflow the response. */
export const PREVIEW_CHARS = 1000;

const cut = (text: string) =>
  text.length > PREVIEW_CHARS
    ? { text: text.slice(0, PREVIEW_CHARS), cut: true }
    : { text, cut: false };

async function readTestsFile(question: QuestionItem): Promise<unknown | undefined> {
  const bucket = process.env[BUCKET_ENV];
  if (!bucket) throw new Error(`Missing environment variable ${BUCKET_ENV}`);
  const key = question.testsKey ?? questionKeys(question.questionId, question.version).tests;

  try {
    const out = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse((await out.Body?.transformToString('utf8')) ?? '');
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
    throw error;
  }
}

/**
 * GET /questions/{id}/tests (teacher): the signature and, once the worker has written tests.json
 * and the question awaits review or is approved, the 10 tests (inputs and expected outputs,
 * each cut to a preview). Otherwise just the current testStatus.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const ctx = await requireUser(event, ['TEACHER']);
  const question = await loadQuestion(ctx, pathParam(event, 'id'));

  const summary: QuestionTestsResponse = {
    questionId: question.questionId,
    version: question.version,
    testStatus: question.testStatus ?? null,
    signature: question.signature ?? null,
    ...(question.testFailure ? { testFailure: question.testFailure } : {}),
  };

  // While GENERATING, an older tests.json may still be in S3; only show it once it is final.
  if (question.testStatus !== 'NEEDS_REVIEW' && question.testStatus !== 'APPROVED') {
    return { status: 200, body: summary };
  }

  const raw = await readTestsFile(question);
  if (raw === undefined) return { status: 200, body: summary };

  const file = testsFileSchema.parse(raw);
  const tests: TestPreview[] = file.tests
    .sort((a, b) => a.index - b.index)
    .map((t) => {
      const input = cut(t.input);
      const expected = cut(t.expected);
      return {
        index: t.index,
        kind: t.kind,
        input: input.text,
        expected: expected.text,
        truncated: input.cut || expected.cut,
      };
    });

  return { status: 200, body: { ...summary, tests } };
}

export const handler = apiHandler(handle);
