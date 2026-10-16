import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AnswerStatus, FailReason, Language } from '../enums.js';
import { examStudentKey, type AnswerItem, type Override, type TestVerdict } from '../types.js';
import { buildSet, docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';

const table = () => tableName('Answers');

export interface AnswerKey {
  examId: string;
  studentEmail: string;
  questionNumber: number;
}

const keyOf = ({ examId, studentEmail, questionNumber }: AnswerKey) => ({
  examStudent: examStudentKey(examId, studentEmail),
  questionNumber,
});

export type WriteOutcome = 'written' | 'stale';

export async function getAnswer(key: AnswerKey): Promise<AnswerItem | undefined> {
  const out = await docClient().send(new GetCommand({ TableName: table(), Key: keyOf(key) }));
  return out.Item as AnswerItem | undefined;
}

/** Every answer a student has in an exam. */
export function listAnswersForStudent(examId: string, studentEmail: string): Promise<AnswerItem[]> {
  return queryAll<AnswerItem>({
    TableName: table(),
    KeyConditionExpression: 'examStudent = :examStudent',
    ExpressionAttributeValues: { ':examStudent': examStudentKey(examId, studentEmail) },
  });
}

/**
 * Starts a new grading attempt: atomically increments `attempt`, sets status QUEUED and clears
 * any earlier failure reason. Creates the answer if it does not exist. Returns the new attempt.
 * Pass `imageKey` for a new upload; omit it to re-run on the stored image.
 */
export async function beginAttempt(key: AnswerKey, imageKey?: string): Promise<number> {
  const names: Record<string, string> = { '#attempt': 'attempt', '#status': 'status' };
  const values: Record<string, unknown> = { ':one': 1, ':queued': 'QUEUED' satisfies AnswerStatus };
  let set = '#status = :queued';
  if (imageKey !== undefined) {
    names['#imageKey'] = 'imageKey';
    values[':imageKey'] = imageKey;
    set += ', #imageKey = :imageKey';
  }
  names['#failReason'] = 'failReason';

  const out = await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: keyOf(key),
      UpdateExpression: `SET ${set} ADD #attempt :one REMOVE #failReason`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return out.Attributes?.['attempt'] as number;
}

/**
 * Writes only if the stored attempt equals `attempt`, so a stale run can never overwrite a
 * newer one. A missing answer counts as stale.
 */
async function writeForAttempt(
  key: AnswerKey,
  attempt: number,
  changes: Record<string, unknown>,
  remove: string[] = [],
): Promise<WriteOutcome> {
  const set = buildSet(changes);
  const names: Record<string, string> = { ...set.names, '#attempt': 'attempt' };
  let expression = set.expression;
  for (const attr of remove) {
    names[`#rm_${attr}`] = attr;
  }
  if (remove.length > 0) {
    expression += ` REMOVE ${remove.map((attr) => `#rm_${attr}`).join(', ')}`;
  }

  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: keyOf(key),
        UpdateExpression: expression,
        ConditionExpression: '#attempt = :expectedAttempt',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...set.values, ':expectedAttempt': attempt },
      }),
    );
    return 'written';
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'stale';
    throw error;
  }
}

export function setAnswerStatus(
  key: AnswerKey,
  attempt: number,
  status: AnswerStatus,
): Promise<WriteOutcome> {
  return writeForAttempt(key, attempt, { status });
}

export interface Transcription {
  language: Language;
  rawTranscription: string;
  correctedCode: string;
  driverCode: string;
  fixes: string[];
  estimatedComplexity: string;
  meetsComplexity: boolean;
}

/** Saves Gemini's output and moves the answer to RUNNING. */
export function saveTranscription(
  key: AnswerKey,
  attempt: number,
  transcription: Transcription,
): Promise<WriteOutcome> {
  return writeForAttempt(key, attempt, { ...transcription, status: 'RUNNING' });
}

/** Ends the answer as FAILED_TO_GRADE with a reason. */
export function markFailed(
  key: AnswerKey,
  attempt: number,
  failReason: FailReason,
): Promise<WriteOutcome> {
  return writeForAttempt(key, attempt, { status: 'FAILED_TO_GRADE', failReason });
}

export interface AnswerResult {
  testsPassed: number;
  testsTotal: number;
  verdicts: TestVerdict[];
  /** Formula score without any override. */
  score: number;
}

/**
 * The Record stage's conditional write: succeeds only when the stored attempt equals the
 * message's attempt. Marks the answer GRADED. Leaves `override` untouched.
 */
export function recordAnswerResult(
  key: AnswerKey,
  attempt: number,
  result: AnswerResult,
): Promise<WriteOutcome> {
  return writeForAttempt(key, attempt, { ...result, status: 'GRADED' }, ['failReason']);
}

export async function setOverride(key: AnswerKey, override: Override): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: keyOf(key),
      UpdateExpression: 'SET #override = :override',
      ConditionExpression: 'attribute_exists(examStudent)',
      ExpressionAttributeNames: { '#override': 'override' },
      ExpressionAttributeValues: { ':override': override },
    }),
  );
}

export async function clearOverride(key: AnswerKey): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: keyOf(key),
      UpdateExpression: 'REMOVE #override',
      ConditionExpression: 'attribute_exists(examStudent)',
      ExpressionAttributeNames: { '#override': 'override' },
    }),
  );
}
