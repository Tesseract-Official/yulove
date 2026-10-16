import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { BatchItem, UserItem } from '@yulove/shared';

type Item = Record<string, unknown>;

/**
 * A tiny in-memory DynamoDB for the Users and Batches tables. It understands exactly what the
 * shared data-access modules send: Get, Put with attribute_not_exists, Update with SET and
 * attribute_exists, Query on one equality (including the byBatch and byRoll indexes) and Scan.
 */
export class FakeDb {
  readonly users = new Map<string, UserItem>();
  readonly batches = new Map<string, BatchItem>();
  private readonly mock = mockClient(DynamoDBDocumentClient);

  constructor() {
    process.env['USERS_TABLE'] = 'Users';
    process.env['BATCHES_TABLE'] = 'Batches';
    this.install();
  }

  reset(): void {
    this.users.clear();
    this.batches.clear();
  }

  addUser(user: UserItem): UserItem {
    this.users.set(user.email, structuredClone(user));
    return user;
  }

  addBatch(batchId: string, name = `Batch ${batchId}`): void {
    this.batches.set(batchId, { batchId, name });
  }

  private table(name: string | undefined): { rows: Map<string, Item>; key: string } {
    if (name === 'Users') return { rows: this.users as unknown as Map<string, Item>, key: 'email' };
    if (name === 'Batches')
      return { rows: this.batches as unknown as Map<string, Item>, key: 'batchId' };
    throw new Error(`FakeDb has no table ${String(name)}`);
  }

  private install(): void {
    const conditionFailed = () =>
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      });

    this.mock.on(GetCommand).callsFake((input) => {
      const { rows } = this.table(input.TableName);
      const item = rows.get(String(Object.values(input.Key)[0]));
      return { Item: item ? structuredClone(item) : undefined };
    });

    this.mock.on(PutCommand).callsFake((input) => {
      const { rows, key } = this.table(input.TableName);
      const id = String(input.Item[key]);
      if (input.ConditionExpression === `attribute_not_exists(${key})` && rows.has(id)) {
        throw conditionFailed();
      }
      rows.set(id, structuredClone(input.Item));
      return {};
    });

    this.mock.on(UpdateCommand).callsFake((input) => {
      const { rows } = this.table(input.TableName);
      const id = String(Object.values(input.Key)[0]);
      const item = rows.get(id);
      if (input.ConditionExpression?.startsWith('attribute_exists') && !item) {
        throw conditionFailed();
      }
      if (!item) throw new Error('FakeDb: update of a missing item without a condition');

      const assignments = (input.UpdateExpression ?? '').replace(/^SET /, '').split(', ');
      for (const assignment of assignments) {
        const [nameRef, valueRef] = assignment.split(' = ') as [string, string];
        const attr = input.ExpressionAttributeNames?.[nameRef] ?? nameRef;
        item[attr] = structuredClone(input.ExpressionAttributeValues?.[valueRef]);
      }
      return {};
    });

    this.mock.on(QueryCommand).callsFake((input) => {
      const { rows } = this.table(input.TableName);
      const match = /^(\w+) = (:\w+)/.exec(input.KeyConditionExpression ?? '');
      if (!match) throw new Error(`FakeDb cannot read ${input.KeyConditionExpression}`);
      const [, attr, valueRef] = match as unknown as [string, string, string];
      const wanted = input.ExpressionAttributeValues?.[valueRef];
      return {
        Items: [...rows.values()].filter((i) => i[attr] === wanted).map((i) => structuredClone(i)),
      };
    });

    this.mock.on(ScanCommand).callsFake((input) => {
      const { rows } = this.table(input.TableName);
      return { Items: [...rows.values()].map((i) => structuredClone(i)) };
    });
  }
}
