import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from '../errors.js';
import type { QuestionItem, Signature } from '../types.js';
import {
  buildUpdate,
  docClient,
  isConditionalCheckFailure,
  queryAll,
  tableName,
  type UpdateParts,
} from './client.js';
import { normaliseEmail } from '../identity.js';

const table = () => tableName('Questions');

export async function getQuestion(
  questionId: string,
  version: number,
): Promise<QuestionItem | undefined> {
  const out = await docClient().send(
    new GetCommand({ TableName: table(), Key: { questionId, version } }),
  );
  return out.Item as QuestionItem | undefined;
}

/** Highest version of a question. */
export async function getLatestQuestion(questionId: string): Promise<QuestionItem | undefined> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'questionId = :questionId',
      ExpressionAttributeValues: { ':questionId': questionId },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return out.Items?.[0] as QuestionItem | undefined;
}

/** Creates one version; throws ConflictError (409) if that version already exists. */
export async function createQuestion(question: QuestionItem): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: { ...question, teacherEmail: normaliseEmail(question.teacherEmail) },
        ConditionExpression: 'attribute_not_exists(questionId)',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      throw new ConflictError(`Question ${question.questionId} v${question.version} exists`);
    }
    throw error;
  }
}

export type QuestionUpdate = Partial<Omit<QuestionItem, 'questionId' | 'version' | 'teacherEmail'>>;

const TEST_ATTRIBUTES = [
  'testStatus',
  'testCount',
  'testsKey',
  'signature',
  'testFailure',
  'testRegenerations',
  'testGenTries',
] as const;

export interface UpdateQuestionOptions {
  /** Attributes to remove. */
  remove?: readonly string[];
  /** Also add 1 to `testAttempt`, which makes any generation still running stale. */
  bumpAttempt?: boolean;
}

/** Updates an existing version. Returns false when it does not exist. */
export async function updateQuestion(
  questionId: string,
  version: number,
  changes: QuestionUpdate,
  options: UpdateQuestionOptions = {},
): Promise<boolean> {
  const update = buildUpdate({
    set: changes,
    remove: options.remove,
    add: options.bumpAttempt ? { testAttempt: 1 } : {},
  });
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: 'attribute_exists(questionId)',
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues:
          Object.keys(update.values).length > 0 ? update.values : undefined,
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
}

/** Changes content and throws away the generated tests, signature and status. */
export function resetQuestionTests(
  questionId: string,
  version: number,
  changes: QuestionUpdate,
): Promise<boolean> {
  return updateQuestion(questionId, version, changes, {
    remove: TEST_ATTRIBUTES,
    bumpAttempt: true,
  });
}

/**
 * Starts a full generation round: status GENERATING, failure cleared, `testAttempt` + 1 and the
 * regeneration counter back to 0.
 * Returns the new attempt, or undefined when the version does not exist.
 */
export async function beginGeneration(
  questionId: string,
  version: number,
): Promise<number | undefined> {
  const update = buildUpdate({
    set: { testStatus: 'GENERATING', testRegenerations: 0 },
    add: { testAttempt: 1 },
    remove: ['testFailure', 'testGenTries'],
  });
  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: 'attribute_exists(questionId)',
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues: update.values,
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return out.Attributes?.['testAttempt'] as number;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return undefined;
    throw error;
  }
}

export type GenerationWrite = 'written' | 'stale';

async function writeForGeneration(
  questionId: string,
  version: number,
  attempt: number,
  parts: UpdateParts,
): Promise<GenerationWrite> {
  const update = buildUpdate(parts);
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: '#testAttempt = :expectedAttempt',
        ExpressionAttributeNames: { ...update.names, '#testAttempt': 'testAttempt' },
        ExpressionAttributeValues: { ...update.values, ':expectedAttempt': attempt },
      }),
    );
    return 'written';
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'stale';
    throw error;
  }
}

/** Saves the signature from Gemini. Only writes if `attempt` is still the current round. */
export function saveSignature(
  questionId: string,
  version: number,
  attempt: number,
  signature: Signature,
): Promise<GenerationWrite> {
  return writeForGeneration(questionId, version, attempt, { set: { signature } });
}

/**
 * The worker built all 10 tests: moves the round from GENERATING to NEEDS_REVIEW and stores the
 * test count and file. Only for the current round and only once; a stale round or a result that
 * was already recorded returns 'stale' and changes nothing.
 */
export async function saveTestsReady(
  questionId: string,
  version: number,
  attempt: number,
  tests: { testsKey: string; testCount: number },
): Promise<GenerationWrite> {
  const update = buildUpdate({
    set: { testStatus: 'NEEDS_REVIEW', testCount: tests.testCount, testsKey: tests.testsKey },
    remove: ['testFailure', 'testGenTries'],
  });
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: '#testAttempt = :expectedAttempt AND #current = :generating',
        ExpressionAttributeNames: {
          ...update.names,
          '#testAttempt': 'testAttempt',
          '#current': 'testStatus',
        },
        ExpressionAttributeValues: {
          ...update.values,
          ':expectedAttempt': attempt,
          ':generating': 'GENERATING',
        },
      }),
    );
    return 'written';
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'stale';
    throw error;
  }
}

/**
 * Counts one more time that this round ended because Gemini was busy (rate limited or
 * unavailable). Only counts for the current round. Returns the new count, or 'stale'.
 */
export async function countGenerationTry(
  questionId: string,
  version: number,
  attempt: number,
): Promise<number | 'stale'> {
  const update = buildUpdate({ add: { testGenTries: 1 } });
  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: '#testAttempt = :expectedAttempt',
        ExpressionAttributeNames: { ...update.names, '#testAttempt': 'testAttempt' },
        ExpressionAttributeValues: { ...update.values, ':expectedAttempt': attempt },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return out.Attributes?.['testGenTries'] as number;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'stale';
    throw error;
  }
}

/** Ends the round as GENERATION_FAILED. Only writes if `attempt` is still the current round. */
export function markGenerationFailed(
  questionId: string,
  version: number,
  attempt: number,
  reason: string,
): Promise<GenerationWrite> {
  return writeForGeneration(questionId, version, attempt, {
    set: { testStatus: 'GENERATION_FAILED', testFailure: reason },
    remove: ['testGenTries'],
  });
}

/**
 * Moves from round `attempt` to the next one (inputs are being regenerated): status
 * GENERATING, `testAttempt` + 1, `testRegenerations` + 1. Returns the new attempt, or 'stale' if
 * `attempt` is not current.
 */
export async function advanceGeneration(
  questionId: string,
  version: number,
  attempt: number,
): Promise<number | 'stale'> {
  const update = buildUpdate({
    set: { testStatus: 'GENERATING' },
    add: { testAttempt: 1, testRegenerations: 1 },
    remove: ['testFailure', 'testGenTries'],
  });
  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: '#testAttempt = :expectedAttempt',
        ExpressionAttributeNames: { ...update.names, '#testAttempt': 'testAttempt' },
        ExpressionAttributeValues: { ...update.values, ':expectedAttempt': attempt },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return out.Attributes?.['testAttempt'] as number;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'stale';
    throw error;
  }
}

/** NEEDS_REVIEW -> APPROVED. Returns false when the version is not (or no longer) in NEEDS_REVIEW. */
export async function approveQuestion(questionId: string, version: number): Promise<boolean> {
  const update = buildUpdate({ set: { testStatus: 'APPROVED' } });
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: update.expression,
        ConditionExpression: '#current = :needsReview',
        ExpressionAttributeNames: { ...update.names, '#current': 'testStatus' },
        ExpressionAttributeValues: { ...update.values, ':needsReview': 'NEEDS_REVIEW' },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
}

/** A teacher's questions, all versions (index byTeacher). */
export function listQuestionsByTeacher(teacherEmail: string): Promise<QuestionItem[]> {
  return queryAll<QuestionItem>({
    TableName: table(),
    IndexName: 'byTeacher',
    KeyConditionExpression: 'teacherEmail = :teacherEmail',
    ExpressionAttributeValues: { ':teacherEmail': normaliseEmail(teacherEmail) },
  });
}
