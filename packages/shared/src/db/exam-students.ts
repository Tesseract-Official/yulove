import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mapLimit } from '../concurrency.js';
import type { ExamStudentItem } from '../types.js';
import { docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';
import { normaliseEmail } from '../identity.js';

const table = () => tableName('ExamStudents');

export async function getExamStudent(
  examId: string,
  studentEmail: string,
): Promise<ExamStudentItem | undefined> {
  const out = await docClient().send(
    new GetCommand({
      TableName: table(),
      Key: { examId, studentEmail: normaliseEmail(studentEmail) },
    }),
  );
  return out.Item as ExamStudentItem | undefined;
}

/** Rows written at the same time. */
const WRITE_CONCURRENCY = 25;
const MAX_ATTEMPTS = 6;

/** Errors DynamoDB gives when it is busy; a row hitting one is tried again after a pause. */
const BUSY_ERRORS = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PutExamStudentsOptions {
  /** For tests. */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface PutExamStudentsResult {
  written: number;
  /** Rows DynamoDB still would not take after every retry. */
  unwritten: ExamStudentItem[];
}

/**
 * Writes many rows with PutItem, 25 at a time (BatchWriteItem would also let a caller delete, which
 * no route may do). A row that meets a "busy" error is retried with a growing pause; whatever is
 * still refused after that comes back in `unwritten`. A row for the same student given twice is
 * written once. Any other error is thrown.
 */
export async function putExamStudents(
  items: readonly ExamStudentItem[],
  options: PutExamStudentsOptions = {},
): Promise<PutExamStudentsResult> {
  const pause = options.sleepMs ?? sleep;
  const unique = [...new Map(items.map((i) => [normaliseEmail(i.studentEmail), i])).values()].map(
    (i) => ({ ...i, studentEmail: normaliseEmail(i.studentEmail) }),
  );

  const putOne = async (Item: ExamStudentItem): Promise<boolean> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await pause(50 * 2 ** attempt);
      try {
        await docClient().send(new PutCommand({ TableName: table(), Item }));
        return true;
      } catch (error) {
        if (!BUSY_ERRORS.has((error as { name?: string } | undefined)?.name ?? '')) throw error;
      }
    }
    return false;
  };

  const done = await mapLimit(unique, WRITE_CONCURRENCY, putOne);
  const unwritten = unique.filter((_, i) => !done[i]);
  return { written: unique.length - unwritten.length, unwritten };
}

/**
 * The student's row for this exam, created now if it does not exist yet (students imported after
 * the exam was made have no row until their first access). Safe if two requests race.
 */
export async function getOrCreateExamStudent(
  examId: string,
  studentEmail: string,
): Promise<ExamStudentItem> {
  const existing = await getExamStudent(examId, studentEmail);
  if (existing) return existing;

  const row: ExamStudentItem = {
    examId,
    studentEmail: normaliseEmail(studentEmail),
    absent: false,
  };
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: row,
        ConditionExpression: 'attribute_not_exists(examId)',
      }),
    );
    return row;
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error;
    const created = await getExamStudent(examId, studentEmail);
    if (!created) throw error;
    return created;
  }
}

export async function putExamStudent(item: ExamStudentItem): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: table(),
      Item: { ...item, studentEmail: normaliseEmail(item.studentEmail) },
    }),
  );
}

/** Marks or unmarks a student absent, creating the row if needed. */
export async function setAbsent(
  examId: string,
  studentEmail: string,
  absent: boolean,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: { examId, studentEmail: normaliseEmail(studentEmail) },
      UpdateExpression: 'SET absent = :absent',
      ExpressionAttributeValues: { ':absent': absent },
    }),
  );
}

/** Stores the computed totals, creating the row if needed. */
export async function setTotals(
  examId: string,
  studentEmail: string,
  totalScore: number,
  maxScore: number,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: { examId, studentEmail: normaliseEmail(studentEmail) },
      UpdateExpression:
        'SET totalScore = :totalScore, maxScore = :maxScore, absent = if_not_exists(absent, :no)',
      ExpressionAttributeValues: { ':totalScore': totalScore, ':maxScore': maxScore, ':no': false },
    }),
  );
}

/** Every student row of an exam. */
export function listExamStudents(examId: string): Promise<ExamStudentItem[]> {
  return queryAll<ExamStudentItem>({
    TableName: table(),
    KeyConditionExpression: 'examId = :examId',
    ExpressionAttributeValues: { ':examId': examId },
  });
}

/** Every exam row of a student (index byStudent). */
export function listExamsForStudent(studentEmail: string): Promise<ExamStudentItem[]> {
  return queryAll<ExamStudentItem>({
    TableName: table(),
    IndexName: 'byStudent',
    KeyConditionExpression: 'studentEmail = :studentEmail',
    ExpressionAttributeValues: { ':studentEmail': normaliseEmail(studentEmail) },
  });
}
