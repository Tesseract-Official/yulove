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

export interface SeedOutcome {
  email: string;
  status: SeedResult | 'failed';
  /** Why it failed. */
  message?: string;
}

/**
 * Seeds each email as SUPER_ADMIN. One bad address or conflicting account does not stop the
 * others; every email gets its own outcome. Never overwrites an existing user.
 */
export async function seedSuperAdmins(
  client: DynamoDBDocumentClient,
  table: string,
  emails: readonly string[],
  name?: string,
): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  for (const raw of emails) {
    try {
      const email = normaliseEmail(raw);
      outcomes.push({ email, status: await seedSuperAdmin(client, table, email, name) });
    } catch (error) {
      outcomes.push({
        email: raw,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

/** One line per outcome, for the console. */
export function describeOutcome(outcome: SeedOutcome, table: string): string {
  switch (outcome.status) {
    case 'created':
      return `Added ${outcome.email} to ${table} as ${SUPER_ADMIN}.`;
    case 'already-seeded':
      return `${outcome.email} is already a ${SUPER_ADMIN} in ${table}; nothing changed.`;
    case 'failed':
      return `FAILED ${outcome.email}: ${outcome.message ?? 'unknown error'}`;
  }
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
  const table = values.table ?? process.env['USERS_TABLE'];
  if (positionals.length === 0 || !table) {
    throw new Error(
      'Usage: USERS_TABLE=<table> tsx seed-super-admin.ts <email> [<email> ...] [--name "Full Name"] [--table <table>]',
    );
  }
  if (values.name !== undefined && positionals.length > 1) {
    throw new Error('--name can only be used with a single email.');
  }

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'ap-south-1' }),
  );
  const outcomes = await seedSuperAdmins(client, table, positionals, values.name);
  for (const outcome of outcomes) console.log(describeOutcome(outcome, table));
  if (outcomes.some((outcome) => outcome.status === 'failed')) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
