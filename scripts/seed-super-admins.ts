import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeOutcome, seedSuperAdmins } from './seed-super-admin.js';

export const REGION = 'ap-south-1';
export const DATA_STACK = 'DsaJudgeData';
export const USERS_TABLE_OUTPUT = 'UsersTableName';

const CDK_JSON = fileURLToPath(new URL('../infra/cdk.json', import.meta.url));

/** The `superAdminEmails` list from infra/cdk.json (the same list the pre-sign-up Lambda uses). */
export function readSuperAdminEmails(configPath: string = CDK_JSON): string[] {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    context?: { superAdminEmails?: unknown };
  };
  const list = config.context?.superAdminEmails;
  if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === 'string')) {
    throw new Error(`${configPath} has no "superAdminEmails" list in its context.`);
  }
  return list as string[];
}

/** The Users table name, read from the deployed data stack's outputs. */
export async function usersTableFromStack(client: CloudFormationClient): Promise<string> {
  const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: DATA_STACK }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === USERS_TABLE_OUTPUT);
  if (!output?.OutputValue) {
    throw new Error(`Stack ${DATA_STACK} has no output ${USERS_TABLE_OUTPUT}. Is it deployed?`);
  }
  return output.OutputValue;
}

/**
 * Seeds every address in infra/cdk.json's `superAdminEmails` as SUPER_ADMIN.
 * Needs AWS_PROFILE, so the default credentials are never used by accident.
 */
async function main(): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(
      'Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm seed:super-admins',
    );
  }
  const emails = readSuperAdminEmails();

  // Both clients read AWS_PROFILE through the SDK's default credential chain.
  const table = await usersTableFromStack(new CloudFormationClient({ region: REGION }));
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  console.log(`Profile ${profile}, table ${table}.`);
  const outcomes = await seedSuperAdmins(client, table, emails);
  for (const outcome of outcomes) console.log(describeOutcome(outcome, table));
  if (outcomes.some((outcome) => outcome.status === 'failed')) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
