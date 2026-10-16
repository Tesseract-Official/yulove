import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from '../errors.js';
import type { BatchItem } from '../types.js';
import { docClient, isConditionalCheckFailure, tableName } from './client.js';

const table = () => tableName('Batches');

export async function getBatch(batchId: string): Promise<BatchItem | undefined> {
  const out = await docClient().send(new GetCommand({ TableName: table(), Key: { batchId } }));
  return out.Item as BatchItem | undefined;
}

/** Creates a batch; throws ConflictError (409) if the id is taken. */
export async function createBatch(batch: BatchItem): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: batch,
        ConditionExpression: 'attribute_not_exists(batchId)',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailure(error)) throw new ConflictError(`Batch ${batch.batchId} exists`);
    throw error;
  }
}

/** Every batch. The table is tiny (one college), so a scan is fine. */
export async function listBatches(): Promise<BatchItem[]> {
  const items: BatchItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient().send(
      new ScanCommand({ TableName: table(), ExclusiveStartKey: startKey }),
    );
    items.push(...((page.Items ?? []) as BatchItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}
