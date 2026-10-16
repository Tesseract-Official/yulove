import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AppealStatus } from '../enums.js';
import { ConflictError } from '../errors.js';
import type { AppealItem } from '../types.js';
import { buildSet, docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';
import { normaliseEmail } from '../identity.js';

const table = () => tableName('Appeals');

export async function getAppeal(appealId: string): Promise<AppealItem | undefined> {
  const out = await docClient().send(new GetCommand({ TableName: table(), Key: { appealId } }));
  return out.Item as AppealItem | undefined;
}

/** Creates an appeal; throws ConflictError (409) if the id exists. */
export async function createAppeal(appeal: AppealItem): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: { ...appeal, studentEmail: normaliseEmail(appeal.studentEmail) },
        ConditionExpression: 'attribute_not_exists(appealId)',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailure(error))
      throw new ConflictError(`Appeal ${appeal.appealId} exists`);
    throw error;
  }
}

/** Appeals of an exam, optionally only one status (index byExam). */
export function listAppealsByExam(examId: string, status?: AppealStatus): Promise<AppealItem[]> {
  return queryAll<AppealItem>({
    TableName: table(),
    IndexName: 'byExam',
    KeyConditionExpression: status ? 'examId = :examId AND #status = :status' : 'examId = :examId',
    ...(status ? { ExpressionAttributeNames: { '#status': 'status' } } : {}),
    ExpressionAttributeValues: status
      ? { ':examId': examId, ':status': status }
      : { ':examId': examId },
  });
}

/** The open appeal for this student and question, if any (one open appeal per question). */
export async function findOpenAppeal(
  examId: string,
  studentEmail: string,
  questionNumber: number,
): Promise<AppealItem | undefined> {
  const email = normaliseEmail(studentEmail);
  const open = await listAppealsByExam(examId, 'OPEN');
  return open.find((a) => a.studentEmail === email && a.questionNumber === questionNumber);
}

export type AppealUpdate = Partial<Pick<AppealItem, 'status' | 'handledBy' | 'note'>>;

/** Updates an existing appeal. Returns false when it does not exist. */
export async function updateAppeal(appealId: string, changes: AppealUpdate): Promise<boolean> {
  const set = buildSet({
    ...changes,
    ...(changes.handledBy === undefined ? {} : { handledBy: normaliseEmail(changes.handledBy) }),
  });
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { appealId },
        UpdateExpression: set.expression,
        ConditionExpression: 'attribute_exists(appealId)',
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
