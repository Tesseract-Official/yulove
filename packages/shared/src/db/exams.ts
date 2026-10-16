import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from '../errors.js';
import type { ExamItem } from '../types.js';
import { buildSet, docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';

const table = () => tableName('Exams');

export async function getExam(examId: string): Promise<ExamItem | undefined> {
  const out = await docClient().send(new GetCommand({ TableName: table(), Key: { examId } }));
  return out.Item as ExamItem | undefined;
}

/** Creates an exam; throws ConflictError (409) if the id exists. */
export async function createExam(exam: ExamItem): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: exam,
        ConditionExpression: 'attribute_not_exists(examId)',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailure(error)) throw new ConflictError(`Exam ${exam.examId} exists`);
    throw error;
  }
}

export type ExamUpdate = Partial<Omit<ExamItem, 'examId'>>;

/** Updates an existing exam. Returns false when it does not exist. */
export async function updateExam(examId: string, changes: ExamUpdate): Promise<boolean> {
  const set = buildSet(changes);
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { examId },
        UpdateExpression: set.expression,
        ConditionExpression: 'attribute_exists(examId)',
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

/** Exams of a batch (index byBatch). */
export function listExamsByBatch(batchId: string): Promise<ExamItem[]> {
  return queryAll<ExamItem>({
    TableName: table(),
    IndexName: 'byBatch',
    KeyConditionExpression: 'batchId = :batchId',
    ExpressionAttributeValues: { ':batchId': batchId },
  });
}
