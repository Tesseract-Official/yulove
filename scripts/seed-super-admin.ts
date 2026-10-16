import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { normaliseEmail as normaliseIdentity, ROLES } from '@yulove/shared';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SUPER_ADMIN = ROLES[0];

export type SeedResult = 'created' | 'already-seeded';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(raw: string): string {
  const email = normaliseIdentity(raw);
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error(`"${raw}" is not a valid email address.`);
  }
  return email;
}

/** Adds the email to the Users table as SUPER_ADMIN. Never overwrites an existing user. */
export async function seedSuperAdmin(
  client: DynamoDBDocumentClient,
  table: string,
  rawEmail: string,
  name?: string,
): Promise<SeedResult> {
  const email = normaliseEmail(rawEmail);

  try {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: { email, role: SUPER_ADMIN, name: name?.trim() || email, active: true },
        ConditionExpression: 'attribute_not_exists(email)',
      }),
    );
    return 'created';
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }

  const existing = await client.send(
    new GetCommand({ TableName: table, Key: { email }, ConsistentRead: true }),
  );
  if (existing.Item?.['role'] === SUPER_ADMIN) return 'already-seeded';
  throw new Error(
    `${email} already exists in ${table} with role ${String(existing.Item?.['role'])}; not overwriting.`,
  );
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      table: { type: 'string' },
      name: { type: 'string' },
    },
  });
  const email = positionals[0];
  const table = values.table ?? process.env['USERS_TABLE'];
  if (!email || !table) {
    throw new Error(
      'Usage: USERS_TABLE=<table> tsx seed-super-admin.ts <email> [--name "Full Name"] [--table <table>]',
    );
  }

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'ap-south-1' }),
  );
  const result = await seedSuperAdmin(client, table, email, values.name);
  console.log(
    result === 'created'
      ? `Added ${normaliseEmail(email)} to ${table} as ${SUPER_ADMIN}.`
      : `${normaliseEmail(email)} is already a ${SUPER_ADMIN} in ${table}; nothing changed.`,
  );
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
