import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from '../errors.js';
import type { QuestionItem } from '../types.js';
import { buildSet, docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';

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
        Item: question,
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

/** Updates an existing version. Returns false when it does not exist. */
export async function updateQuestion(
  questionId: string,
  version: number,
  changes: QuestionUpdate,
): Promise<boolean> {
  const set = buildSet(changes);
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { questionId, version },
        UpdateExpression: set.expression,
        ConditionExpression: 'attribute_exists(questionId)',
        ExpressionAttributeNames: set.names,
        ExpressionAttributeValues: set.values,
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
    ExpressionAttributeValues: { ':teacherEmail': teacherEmail.toLowerCase() },
  });
}
