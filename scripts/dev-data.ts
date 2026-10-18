// What cleanup-dev-data.ts and mark-dev-data.ts share: the tables, small DynamoDB helpers and the
// "show the plan, then ask for --yes" rule. Dev data is anything carrying `dev: true`.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DATA_STACK, REGION } from './seed-super-admins.js';
import { requiredOutput, stackOutputs } from './smoke-worker.js';

export type Item = Record<string, unknown>;

export interface DevTables {
  users: string;
  batches: string;
  questions: string;
  exams: string;
  examStudents: string;
  answers: string;
  appeals: string;
}

export interface Aws {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  bucket: string;
  tables: DevTables;
}

/** Table and bucket names from the deployed data stack's outputs, and clients for them. */
export async function connect(): Promise<Aws> {
  const data = await stackOutputs(new CloudFormationClient({ region: REGION }), DATA_STACK);
  const name = (table: string) => requiredOutput(data, `${table}TableName`, DATA_STACK);
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
    s3: new S3Client({ region: REGION }),
    bucket: requiredOutput(data, 'BucketName', DATA_STACK),
    tables: {
      users: name('Users'),
      batches: name('Batches'),
      questions: name('Questions'),
      exams: name('Exams'),
      examStudents: name('ExamStudents'),
      answers: name('Answers'),
      appeals: name('Appeals'),
    },
  };
}

/** The message every script gives when AWS_PROFILE is missing, so the default login is never used by accident. */
export function requireProfile(example: string): string {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(`Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa ${example}`);
  }
  return profile;
}

export async function scanAll(
  ddb: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof ScanCommand>[0],
): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((page.Items ?? []) as Item[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export async function queryAll(
  ddb: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((page.Items ?? []) as Item[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Every item of a table that carries dev = true. The result is checked again here, never trusted. */
export async function scanDev(aws: Aws, table: string): Promise<Item[]> {
  const items = await scanAll(aws.ddb, {
    TableName: table,
    FilterExpression: '#dev = :true',
    ExpressionAttributeNames: { '#dev': 'dev' },
    ExpressionAttributeValues: { ':true': true },
  });
  return items.filter((item) => item['dev'] === true);
}

export const isDev = (item: Item | undefined): boolean => item?.['dev'] === true;

/** How many keys are listed before "and N more". */
const SHOWN = 15;

/** A heading with a count, and the first few lines under it. */
export function section(title: string, lines: readonly string[]): string[] {
  const shown = lines.slice(0, SHOWN).map((line) => `    ${line}`);
  const more = lines.length > SHOWN ? [`    ... and ${lines.length - SHOWN} more`] : [];
  return [`  ${title}: ${lines.length}`, ...shown, ...more];
}

export interface RunMode {
  dryRun: boolean;
  yes: boolean;
}

/**
 * The plan is always shown. A dry run stops after it. A real run needs --yes; without it nothing
 * is changed and the message says what to type.
 */
export function checkMode(mode: RunMode, command: string): 'dry-run' | 'go' {
  if (mode.dryRun) return 'dry-run';
  if (!mode.yes) {
    throw new Error(
      `Nothing was changed. Look at the list above, then run it again with --yes to do it, or with --dry-run to only look: ${command}`,
    );
  }
  return 'go';
}
