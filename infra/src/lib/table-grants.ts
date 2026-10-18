import { Grant, type IGrantable } from 'aws-cdk-lib/aws-iam';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';

/**
 * What a Lambda may do with a table. No level can delete: nothing in this app deletes a row, and a
 * Lambda that cannot delete cannot be talked into it.
 *  - read: get, query, scan and batch-get, on the table and its indexes
 *  - write: PutItem and UpdateItem on the table (UpdateItem also removes attributes)
 *  - readWrite: both
 */
export type TableAccess = 'read' | 'write' | 'readWrite';

/** The write actions: nothing here removes an item, and BatchWriteItem is left out on purpose. */
export const TABLE_WRITE_ACTIONS = ['dynamodb:PutItem', 'dynamodb:UpdateItem'] as const;

export function grantTable(grantee: IGrantable, table: ITable, access: TableAccess): void {
  if (access !== 'write') table.grantReadData(grantee);
  if (access !== 'read') {
    Grant.addToPrincipal({
      grantee,
      actions: [...TABLE_WRITE_ACTIONS],
      resourceArns: [table.tableArn],
    });
  }
}
