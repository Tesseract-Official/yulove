import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditLogItem } from '../types.js';
import { docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';

const table = () => tableName('AuditLog');

/**
 * Adds an entry. Returns false (without writing) when an entry with the same entityKey and
 * timestamp already exists; entries are never overwritten.
 */
export async function putAuditItem(item: AuditLogItem): Promise<boolean> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(entityKey)',
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
}

/** History of one entity, oldest first. */
export function listAuditForEntity(entityKey: string): Promise<AuditLogItem[]> {
  return queryAll<AuditLogItem>({
    TableName: table(),
    KeyConditionExpression: 'entityKey = :entityKey',
    ExpressionAttributeValues: { ':entityKey': entityKey },
  });
}

/** Everything one person did (index byActor). */
export function listAuditByActor(actor: string): Promise<AuditLogItem[]> {
  return queryAll<AuditLogItem>({
    TableName: table(),
    IndexName: 'byActor',
    KeyConditionExpression: 'actor = :actor',
    ExpressionAttributeValues: { ':actor': actor.toLowerCase() },
  });
}
