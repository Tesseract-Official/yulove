import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ExamStudentItem } from '../types.js';
import { docClient, queryAll, tableName } from './client.js';

const table = () => tableName('ExamStudents');

export async function getExamStudent(
  examId: string,
  studentEmail: string,
): Promise<ExamStudentItem | undefined> {
  const out = await docClient().send(
    new GetCommand({
      TableName: table(),
      Key: { examId, studentEmail: studentEmail.toLowerCase() },
    }),
  );
  return out.Item as ExamStudentItem | undefined;
}

export async function putExamStudent(item: ExamStudentItem): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: table(),
      Item: { ...item, studentEmail: item.studentEmail.toLowerCase() },
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
      Key: { examId, studentEmail: studentEmail.toLowerCase() },
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
      Key: { examId, studentEmail: studentEmail.toLowerCase() },
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
    ExpressionAttributeValues: { ':studentEmail': studentEmail.toLowerCase() },
  });
}
