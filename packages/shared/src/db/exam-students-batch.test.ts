import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
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

const busy = () => Object.assign(new Error('slow down'), { name: 'ThrottlingException' });

describe('putExamStudents', () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddb.reset();
    process.env['EXAM_STUDENTS_TABLE'] = 'ExamStudents';
  });

  const written = () => ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item);

  it('writes every row with PutItem, never BatchWriteItem', async () => {
    ddb.on(PutCommand).resolves({});

    const result = await putExamStudents(rows(60), { sleepMs: noSleep });

    expect(written()).toHaveLength(60);
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.TableName).toBe('ExamStudents');
    expect(result).toEqual({ written: 60, unwritten: [] });
  });

  it('writes at most 25 rows at the same time', async () => {
    let running = 0;
    let most = 0;
    ddb.on(PutCommand).callsFake(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return {};
    });

    await putExamStudents(rows(80), { sleepMs: noSleep });

    expect(most).toBe(25);
  });

  it('writes nothing for no rows', async () => {
    const result = await putExamStudents([], { sleepMs: noSleep });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(result).toEqual({ written: 0, unwritten: [] });
  });

  it('stores emails in lower case and writes a repeated student once', async () => {
    ddb.on(PutCommand).resolves({});

    await putExamStudents(
      [
        { examId: 'e1', studentEmail: 'Same@College.edu', absent: false },
        { examId: 'e1', studentEmail: 'same@college.edu', absent: false },
      ],
      { sleepMs: noSleep },
    );

    expect(written()).toEqual([{ examId: 'e1', studentEmail: 'same@college.edu', absent: false }]);
  });

  it('retries a row that meets a busy error, after a pause that grows', async () => {
    const pauses: number[] = [];
    ddb.on(PutCommand).rejectsOnce(busy()).rejectsOnce(busy()).resolves({});

    const result = await putExamStudents(rows(1), { sleepMs: async (ms) => void pauses.push(ms) });

    expect(ddb.commandCalls(PutCommand)).toHaveLength(3);
    expect(result).toEqual({ written: 1, unwritten: [] });
    expect(pauses).toHaveLength(2);
    expect(pauses[1]).toBeGreaterThan(pauses[0] as number);
  });

  it('gives back the rows it could not write after every retry', async () => {
    const all = rows(3);
    ddb.on(PutCommand).callsFake((input) => {
      if (input.Item.studentEmail === 's0@college.edu') return {};
      throw busy();
    });

    const result = await putExamStudents(all, { sleepMs: noSleep });

    expect(result.written).toBe(1);
    expect(result.unwritten.map((r) => r.studentEmail)).toEqual([
      's1@college.edu',
      's2@college.edu',
    ]);
    // 1 + 6 + 6 attempts: it gives up on a row after 6.
    expect(ddb.commandCalls(PutCommand)).toHaveLength(13);
  });

  it('throws real errors straight away', async () => {
    ddb.on(PutCommand).rejects(new Error('AccessDenied'));
    await expect(putExamStudents(rows(2), { sleepMs: noSleep })).rejects.toThrow('AccessDenied');
  });
});
