import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AnswerStatus, FailReason, Language } from '../enums.js';
import { normaliseEmail } from '../identity.js';
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

/** True when the student has at least one answer (any status) in the exam. */
export async function hasAnyAnswer(examId: string, studentEmail: string): Promise<boolean> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'examStudent = :examStudent',
      ExpressionAttributeValues: { ':examStudent': examStudentKey(examId, studentEmail) },
      Limit: 1,
    }),
  );
  return (out.Items?.length ?? 0) > 0;
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
  names['#failDetail'] = 'failDetail';
  names['#transcribeTries'] = 'transcribeTries';

  const out = await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: keyOf(key),
      UpdateExpression: `SET ${set} ADD #attempt :one REMOVE #failReason, #failDetail, #transcribeTries`,
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
  return writeForAttempt(key, attempt, { ...transcription, status: 'RUNNING' }, [
    'failReason',
    'failDetail',
    'transcribeTries',
  ]);
}

/**
 * Counts one more time that transcription ended because Gemini was busy (rate limited or
 * unavailable). Only counts for the answer's current attempt. Returns the new count, or 'stale'
 * when a newer attempt exists; the counter starts again with every new attempt.
 */
export async function countTranscribeTry(
  key: AnswerKey,
  attempt: number,
): Promise<number | 'stale'> {
  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: keyOf(key),
        UpdateExpression: 'ADD #tries :one',
        ConditionExpression: '#attempt = :expectedAttempt',
        ExpressionAttributeNames: { '#tries': 'transcribeTries', '#attempt': 'attempt' },
        ExpressionAttributeValues: { ':one': 1, ':expectedAttempt': attempt },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return out.Attributes?.['transcribeTries'] as number;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'stale';
    throw error;
  }
}

/** Longest failure explanation that is stored. */
export const MAX_FAIL_DETAIL = 300;

/** Ends the answer as FAILED_TO_GRADE with a reason and, optionally, a readable explanation. */
export function markFailed(
  key: AnswerKey,
  attempt: number,
  failReason: FailReason,
  detail?: string,
): Promise<WriteOutcome> {
  const text = detail?.trim();
  const failDetail =
    text && text.length > MAX_FAIL_DETAIL ? `${text.slice(0, MAX_FAIL_DETAIL - 3)}...` : text;
  return writeForAttempt(
    key,
    attempt,
    { status: 'FAILED_TO_GRADE', failReason, failDetail: failDetail || undefined },
    ['transcribeTries', ...(failDetail ? [] : ['failDetail'])],
  );
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
  return writeForAttempt(key, attempt, { ...result, status: 'GRADED' }, [
    'failReason',
    'failDetail',
    'transcribeTries',
  ]);
}

export async function setOverride(key: AnswerKey, override: Override): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: keyOf(key),
      UpdateExpression: 'SET #override = :override',
      ConditionExpression: 'attribute_exists(examStudent)',
      ExpressionAttributeNames: { '#override': 'override' },
      ExpressionAttributeValues: { ':override': { ...override, by: normaliseEmail(override.by) } },
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

/**
 * Marks this appeal as the open one on the answer, only if there is none. Returns false when
 * another appeal is already open (or the answer does not exist), so two appeals raised at the
 * same moment cannot both open.
 */
export async function claimAppeal(key: AnswerKey, appealId: string): Promise<boolean> {
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: keyOf(key),
        UpdateExpression: 'SET #open = :appealId',
        ConditionExpression: 'attribute_exists(examStudent) AND attribute_not_exists(#open)',
        ExpressionAttributeNames: { '#open': 'openAppealId' },
        ExpressionAttributeValues: { ':appealId': appealId },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
}

/** Clears the open-appeal mark, but only if it is this appeal's. */
export async function releaseAppeal(key: AnswerKey, appealId: string): Promise<void> {
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: keyOf(key),
        UpdateExpression: 'REMOVE #open',
        ConditionExpression: '#open = :appealId',
        ExpressionAttributeNames: { '#open': 'openAppealId' },
        ExpressionAttributeValues: { ':appealId': appealId },
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error;
  }
}
