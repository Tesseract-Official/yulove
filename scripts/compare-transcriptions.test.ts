import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { AnswerItem } from '@yulove/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COLUMNS,
  collectAnswers,
  csvCell,
  csvRow,
  examToCsv,
  LINK_SECONDS,
  outputFile,
  toCsv,
  type Aws,
} from './compare-transcriptions.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const tables = { exams: 'Exams', examStudents: 'ExamStudents', users: 'Users', answers: 'Answers' };

const answer = (n: number, extra: Partial<AnswerItem> = {}): AnswerItem => ({
  examStudent: 'exam-1#a@college.edu',
  questionNumber: n,
  attempt: 1,
  status: 'GRADED',
  imageKey: `answers/exam-1/R${n}/q${n}.jpg`,
  rawTranscription: 'def f(x):\n  return x',
  correctedCode: 'def f(x):\n    return x',
  fixes: ['fixed indentation', 'added a colon'],
  language: 'python',
  estimatedComplexity: 'O(n)',
  testsPassed: 7,
  testsTotal: 10,
  ...extra,
});

function aws(presigned: Array<[string, number]> = []): Aws {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' })),
    s3: new S3Client({ region: 'ap-south-1' }),
    bucket: 'bucket',
    tables,
    presign: async (key, seconds) => {
      presigned.push([key, seconds]);
      return `https://bucket.example/${key}?sig`;
    },
  };
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand, { TableName: 'Exams' }).resolves({ Item: { examId: 'exam-1' } });
  ddbMock
    .on(QueryCommand, { TableName: 'ExamStudents' })
    .resolves({ Items: [{ studentEmail: 'b@college.edu' }, { studentEmail: 'a@college.edu' }] });
  ddbMock.on(GetCommand, { TableName: 'Users', Key: { email: 'a@college.edu' } }).resolves({
    Item: { email: 'a@college.edu', rollNo: 'R10' },
  });
  ddbMock.on(GetCommand, { TableName: 'Users', Key: { email: 'b@college.edu' } }).resolves({
    Item: { email: 'b@college.edu', rollNo: 'R2' },
  });
  ddbMock
    .on(QueryCommand, {
      TableName: 'Answers',
      ExpressionAttributeValues: { ':examStudent': 'exam-1#a@college.edu' },
    })
    .resolves({ Items: [answer(2), answer(1)] });
  ddbMock
    .on(QueryCommand, {
      TableName: 'Answers',
      ExpressionAttributeValues: { ':examStudent': 'exam-1#b@college.edu' },
    })
    .resolves({ Items: [] });
});

describe('csvCell', () => {
  it('leaves plain text alone and blanks an unknown value', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(7)).toBe('7');
    expect(csvCell(0)).toBe('0');
  });

  it('quotes commas, quotes and line breaks, doubling quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd'])(
    'does not let a spreadsheet run %j as a formula',
    (text) => {
      expect(csvCell(text).replace(/^"/, '')).toMatch(/^'/);
    },
  );
});

describe('csvRow and toCsv', () => {
  it('joins cells with commas', () => {
    expect(csvRow(['a', 1, undefined, 'x,y'])).toBe('a,1,,"x,y"');
  });

  it('has the header the founders asked for, then one row per answer ordered by roll number and question', () => {
    const csv = toCsv([
      { rollNo: 'R10', answer: answer(2), link: 'L10-2' },
      { rollNo: 'R2', answer: answer(1), link: 'L2-1' },
      { rollNo: 'R10', answer: answer(1), link: undefined },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(COLUMNS.join(','));
    expect(COLUMNS.slice(0, 3)).toEqual(['Roll number', 'Question', 'Photo link (7 days)']);
    expect(
      lines.filter((l) => /^R\d+,/.test(l)).map((l) => l.split(',').slice(0, 2).join(',')),
    ).toEqual(['R2,1', 'R10,1', 'R10,2']);
  });
});

describe('collectAnswers', () => {
  it('lists each answer with its roll number, a 7-day link and the photo key', async () => {
    const presigned: Array<[string, number]> = [];

    const rows = await collectAnswers(aws(presigned), 'exam-1');

    expect(rows.map((r) => [r.rollNo, r.answer.questionNumber])).toEqual([
      ['R10', 2],
      ['R10', 1],
    ]);
    expect(presigned).toEqual([
      ['answers/exam-1/R2/q2.jpg', LINK_SECONDS],
      ['answers/exam-1/R1/q1.jpg', LINK_SECONDS],
    ]);
    expect(LINK_SECONDS).toBe(604_800);
    expect(rows[0]?.link).toBe('https://bucket.example/answers/exam-1/R2/q2.jpg?sig');
  });

  it('skips a student with no answers, and a missing photo has no link', async () => {
    ddbMock
      .on(QueryCommand, {
        TableName: 'Answers',
        ExpressionAttributeValues: { ':examStudent': 'exam-1#a@college.edu' },
      })
      .resolves({ Items: [answer(1, { imageKey: undefined })] });

    const rows = await collectAnswers(aws(), 'exam-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.link).toBeUndefined();
  });

  it('fails clearly for an exam that does not exist', async () => {
    ddbMock.on(GetCommand, { TableName: 'Exams' }).resolves({});
    await expect(collectAnswers(aws(), 'nope')).rejects.toThrow(/No exam nope/);
  });

  it('follows every page of a student list', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'ExamStudents' })
      .resolvesOnce({ Items: [{ studentEmail: 'a@college.edu' }], LastEvaluatedKey: { x: 1 } })
      .resolvesOnce({ Items: [{ studentEmail: 'b@college.edu' }] });
    ddbMock
      .on(QueryCommand, {
        TableName: 'Answers',
        ExpressionAttributeValues: { ':examStudent': 'exam-1#b@college.edu' },
      })
      .resolves({ Items: [answer(1)] });

    const rows = await collectAnswers(aws(), 'exam-1');

    expect(rows).toHaveLength(3);
  });
});

describe('examToCsv', () => {
  it('writes every column of an answer, with the fixes one per line and the status', async () => {
    const { csv, answers } = await examToCsv(aws(), 'exam-1');

    expect(answers).toBe(2);
    expect(csv).toContain('"added a colon"'.slice(1, -1));
    expect(csv).toContain('"fixed indentation\nadded a colon"');
    expect(csv).toContain(',python,O(n),7,10,GRADED,,answers/exam-1/R1/q1.jpg');
  });
});

describe('outputFile', () => {
  it('names the file after the exam, safely', () => {
    expect(outputFile('exam-1')).toBe('transcription-compare-exam-1.csv');
    expect(outputFile('../x/y')).toBe('transcription-compare-.._x_y.csv');
  });
});

describe('the command', () => {
  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'compare-transcriptions.ts', 'exam-1'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
