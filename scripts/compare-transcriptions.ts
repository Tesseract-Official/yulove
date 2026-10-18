// Writes a spreadsheet (CSV) of every answer of an exam next to its photo, so a person can check by
// hand how well Gemini read the handwriting: the raw transcription, the corrected code, the fixes
// it made, the language and complexity it guessed and how many tests passed. Reads AWS only.
//
//   AWS_PROFILE=dsa-judge pnpm compare:transcriptions <examId>
//
// Open the file in a spreadsheet. The photo links last 7 days, but only as long as the AWS login
// they were made with: after `aws sso login` expires they stop working, so the last column has the
// photo's name in the bucket, and you can run the script again for fresh links.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { examStudentKey, type AnswerItem, type ExamItem, type UserItem } from '@yulove/shared';
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './args.js';
import { DATA_STACK, REGION } from './seed-super-admins.js';
import { requiredOutput, stackOutputs } from './smoke-worker.js';

/** How long a photo link is asked to last: the longest S3 allows. */
export const LINK_SECONDS = 7 * 24 * 60 * 60;

export const COLUMNS = [
  'Roll number',
  'Question',
  'Photo link (7 days)',
  'Raw transcription',
  'Corrected code',
  'Fixes',
  'Language',
  'Estimated complexity',
  'Tests passed',
  'Tests total',
  'Status',
  'Fail reason',
  'Photo key',
] as const;

/**
 * A cell that is safe to open in a spreadsheet. Quotes, commas and line breaks are escaped, and a
 * text that starts with =, +, - or @ gets a leading ' so the spreadsheet shows it instead of
 * running it as a formula (students' code starts with such characters now and then).
 */
export function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: ReadonlyArray<string | number | undefined>): string {
  return cells.map(csvCell).join(',');
}

export interface AnswerRow {
  rollNo: string;
  answer: AnswerItem;
  link: string | undefined;
}

/** The cells of one answer, in the order of COLUMNS. */
export function answerCells({
  rollNo,
  answer,
  link,
}: AnswerRow): Array<string | number | undefined> {
  return [
    rollNo,
    answer.questionNumber,
    link,
    answer.rawTranscription,
    answer.correctedCode,
    answer.fixes?.join('\n'),
    answer.language,
    answer.estimatedComplexity,
    answer.testsPassed,
    answer.testsTotal,
    answer.status,
    answer.failReason,
    answer.imageKey,
  ];
}

/** The whole file: a header row, then one row per answer, by roll number and question number. */
export function toCsv(rows: readonly AnswerRow[]): string {
  const sorted = [...rows].sort(
    (a, b) =>
      a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }) ||
      a.answer.questionNumber - b.answer.questionNumber,
  );
  return [csvRow(COLUMNS), ...sorted.map((row) => csvRow(answerCells(row)))].join('\r\n') + '\r\n';
}

export interface Tables {
  exams: string;
  examStudents: string;
  users: string;
  answers: string;
}

export interface Aws {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  bucket: string;
  tables: Tables;
  /** Signs a link; the real one uses the s3-request-presigner package. */
  presign?: (key: string, seconds: number) => Promise<string>;
}

async function queryAll(
  ddb: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Collects every answer of the exam with its student's roll number and a photo link. */
export async function collectAnswers(aws: Aws, examId: string): Promise<AnswerRow[]> {
  const { Item: exam } = await aws.ddb.send(
    new GetCommand({ TableName: aws.tables.exams, Key: { examId } }),
  );
  if (!exam) throw new Error(`No exam ${examId}. Check the id on the Admin or Teacher screen.`);

  const presign =
    aws.presign ??
    ((key: string, seconds: number) =>
      getSignedUrl(aws.s3, new GetObjectCommand({ Bucket: aws.bucket, Key: key }), {
        expiresIn: seconds,
      }));

  const students = (await queryAll(aws.ddb, {
    TableName: aws.tables.examStudents,
    KeyConditionExpression: 'examId = :examId',
    ExpressionAttributeValues: { ':examId': (exam as ExamItem).examId },
  })) as Array<{ studentEmail: string }>;

  const rows: AnswerRow[] = [];
  for (const { studentEmail } of students) {
    const answers = (await queryAll(aws.ddb, {
      TableName: aws.tables.answers,
      KeyConditionExpression: 'examStudent = :examStudent',
      ExpressionAttributeValues: { ':examStudent': examStudentKey(examId, studentEmail) },
    })) as unknown as AnswerItem[];
    if (answers.length === 0) continue;

    const { Item: user } = await aws.ddb.send(
      new GetCommand({ TableName: aws.tables.users, Key: { email: studentEmail } }),
    );
    const rollNo = (user as UserItem | undefined)?.rollNo ?? studentEmail;
    for (const answer of answers) {
      rows.push({
        rollNo,
        answer,
        link: answer.imageKey ? await presign(answer.imageKey, LINK_SECONDS) : undefined,
      });
    }
  }
  return rows;
}

export async function examToCsv(
  aws: Aws,
  examId: string,
): Promise<{ csv: string; answers: number }> {
  const rows = await collectAnswers(aws, examId);
  return { csv: toCsv(rows), answers: rows.length };
}

/** The file name, in the folder the script is run from. */
export function outputFile(examId: string): string {
  return `transcription-compare-${examId.replace(/[^A-Za-z0-9._-]/g, '_')}.csv`;
}

async function main(argv: string[]): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(
      'Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm compare:transcriptions <examId>',
    );
  }
  const { positionals } = parseFlags(argv, {}, true);
  const [examId, ...extra] = positionals;
  if (!examId || extra.length > 0) {
    throw new Error('Usage: AWS_PROFILE=dsa-judge pnpm compare:transcriptions <examId>');
  }

  const data = await stackOutputs(new CloudFormationClient({ region: REGION }), DATA_STACK);
  const aws: Aws = {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
    s3: new S3Client({ region: REGION }),
    bucket: requiredOutput(data, 'BucketName', DATA_STACK),
    tables: {
      exams: requiredOutput(data, 'ExamsTableName', DATA_STACK),
      examStudents: requiredOutput(data, 'ExamStudentsTableName', DATA_STACK),
      users: requiredOutput(data, 'UsersTableName', DATA_STACK),
      answers: requiredOutput(data, 'AnswersTableName', DATA_STACK),
    },
  };

  console.log(`Profile ${profile}, exam ${examId}.`);
  const { csv, answers } = await examToCsv(aws, examId);
  const file = outputFile(examId);
  writeFileSync(file, csv);
  console.log(`Wrote ${answers} answers to ${file}.`);
  console.log(
    'The photo links work for up to 7 days, or until this AWS login expires, whichever is first. The last column has each photo name; run the script again for fresh links.',
  );
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
