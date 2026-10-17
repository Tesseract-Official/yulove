import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExamStudentItem } from '../types.js';
import { putExamStudents } from './exam-students.js';

const rows = (n: number, prefix = 's'): ExamStudentItem[] =>
  Array.from({ length: n }, (_, i) => ({
    examId: 'e1',
    studentEmail: `${prefix}${i}@college.edu`,
    absent: false,
  }));

const noSleep = async () => undefined;

describe('putExamStudents', () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddb.reset();
    process.env['EXAM_STUDENTS_TABLE'] = 'ExamStudents';
  });

  const requests = () =>
    ddb
      .commandCalls(BatchWriteCommand)
      .map((c) => c.args[0].input.RequestItems?.['ExamStudents'] ?? []);

  it('writes 25 rows per call', async () => {
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await putExamStudents(rows(60), { sleepMs: noSleep });

    expect(requests().map((r) => r.length)).toEqual([25, 25, 10]);
    expect(result).toEqual({ written: 60, unwritten: [] });
  });

  it('writes nothing for no rows', async () => {
    const result = await putExamStudents([], { sleepMs: noSleep });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(result).toEqual({ written: 0, unwritten: [] });
  });

  it('stores emails in lower case and writes a repeated student once', async () => {
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    await putExamStudents(
      [
        { examId: 'e1', studentEmail: 'Same@College.edu', absent: false },
        { examId: 'e1', studentEmail: 'same@college.edu', absent: false },
      ],
      { sleepMs: noSleep },
    );

    const [only] = requests();
    expect(only).toHaveLength(1);
    expect(only?.[0]).toEqual({
      PutRequest: { Item: { examId: 'e1', studentEmail: 'same@college.edu', absent: false } },
    });
  });

  it('retries rows DynamoDB returns as unprocessed, after a pause that grows', async () => {
    const pauses: number[] = [];
    const first = rows(3);
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          ExamStudents: first.slice(1).map((Item) => ({ PutRequest: { Item } })),
        },
      })
      .resolvesOnce({
        UnprocessedItems: {
          ExamStudents: first.slice(2).map((Item) => ({ PutRequest: { Item } })),
        },
      })
      .resolves({ UnprocessedItems: {} });

    const result = await putExamStudents(first, { sleepMs: async (ms) => void pauses.push(ms) });

    expect(requests().map((r) => r.length)).toEqual([3, 2, 1]);
    expect(result).toEqual({ written: 3, unwritten: [] });
    expect(pauses).toHaveLength(2);
    expect(pauses[1]).toBeGreaterThan(pauses[0] as number);
  });

  it('gives back the rows it could not write after every retry', async () => {
    const all = rows(3);
    ddb.on(BatchWriteCommand).resolves({
      UnprocessedItems: { ExamStudents: all.slice(1).map((Item) => ({ PutRequest: { Item } })) },
    });

    const result = await putExamStudents(all, { sleepMs: noSleep });

    expect(result.written).toBe(1);
    expect(result.unwritten.map((r) => r.studentEmail)).toEqual([
      's1@college.edu',
      's2@college.edu',
    ]);
    expect(ddb.commandCalls(BatchWriteCommand).length).toBe(6); // gives up after 6 attempts
  });

  it('throws real errors', async () => {
    ddb.on(BatchWriteCommand).rejects(new Error('AccessDenied'));
    await expect(putExamStudents(rows(2), { sleepMs: noSleep })).rejects.toThrow('AccessDenied');
  });
});
