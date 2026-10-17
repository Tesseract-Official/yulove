import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from '../errors.js';
import { normaliseEmail } from '../identity.js';
import type { ExamItem } from '../types.js';
import {
  buildUpdate,
  docClient,
  isConditionalCheckFailure,
  queryAll,
  tableName,
} from './client.js';

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

export type ExamUpdate = Partial<Omit<ExamItem, 'examId' | 'createdBy'>>;

/**
 * Updates an existing exam; `remove` lists attributes to delete (such as pdfKey).
 * Returns false when it does not exist.
 */
export async function updateExam(
  examId: string,
  changes: ExamUpdate,
  remove: readonly (keyof ExamItem)[] = [],
): Promise<boolean> {
  const update = buildUpdate({
    set: {
      ...changes,
      ...(changes.publishedBy === undefined
        ? {}
        : { publishedBy: normaliseEmail(changes.publishedBy) }),
    },
    remove,
  });
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { examId },
        UpdateExpression: update.expression,
        ConditionExpression: 'attribute_exists(examId)',
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

/** Exams of a batch (index byBatch). */
export function listExamsByBatch(batchId: string): Promise<ExamItem[]> {
  return queryAll<ExamItem>({
    TableName: table(),
    IndexName: 'byBatch',
    KeyConditionExpression: 'batchId = :batchId',
    ExpressionAttributeValues: { ':batchId': batchId },
  });
}

/** Exams whose question list includes this exact question version. */
export async function listExamsUsingQuestion(
  questionId: string,
  version: number,
): Promise<ExamItem[]> {
  const items: ExamItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient().send(
      new ScanCommand({ TableName: table(), ExclusiveStartKey: startKey }),
    );
    items.push(...((page.Items ?? []) as ExamItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items.filter((exam) =>
    exam.questions.some((q) => q.questionId === questionId && q.version === version),
  );
}
