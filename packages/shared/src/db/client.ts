import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_ENV, type TableName } from '../tables.js';

let client: DynamoDBDocumentClient | undefined;

/** One shared DocumentClient per Lambda container. */
export function docClient(): DynamoDBDocumentClient {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return client;
}

/** Reads a table name from the env var that ApiStack.addRoute sets. */
export function tableName(table: TableName): string {
  const envVar = TABLE_ENV[table];
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`Missing environment variable ${envVar} for the ${table} table`);
  }
  return value;
}

/** Runs a query and follows LastEvaluatedKey until every page is read. */
export async function queryAll<T>(input: QueryCommandInput): Promise<T[]> {
  const items: T[] = [];
  let startKey = input.ExclusiveStartKey;
  do {
    const page = await docClient().send(
      new QueryCommand({ ...input, ExclusiveStartKey: startKey }),
    );
    items.push(...((page.Items ?? []) as T[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/**
 * Builds the SET part of an UpdateExpression from a plain object. Keys with undefined values are
 * skipped. Attribute names are aliased so reserved words (status, name, date...) are safe.
 */
export function buildSet(values: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const attrValues: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    names[`#${key}`] = key;
    attrValues[`:${key}`] = value;
    parts.push(`#${key} = :${key}`);
  }
  if (parts.length === 0) throw new Error('No values to update');
  return {
    expression: `SET ${parts.join(', ')}`,
    names,
    values: attrValues,
  };
}
