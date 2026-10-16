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
import { TABLE_ENV, TABLE_NAMES, type TableName } from '../tables.js';
import type { BatchItem, UserItem } from '../types.js';

type Item = Record<string, unknown>;

interface TableDef {
  pk: string;
  sk?: string;
  /** index name -> its partition key attribute */
  indexes?: Record<string, string>;
}

/** Keys and indexes exactly as in infra's DataStack. */
const DEFS: Record<TableName, TableDef> = {
  Users: { pk: 'email', indexes: { byBatch: 'batchId', byRoll: 'rollNo' } },
  Batches: { pk: 'batchId' },
  Questions: { pk: 'questionId', sk: 'version', indexes: { byTeacher: 'teacherEmail' } },
  Exams: { pk: 'examId', indexes: { byBatch: 'batchId' } },
  ExamStudents: { pk: 'examId', sk: 'studentEmail', indexes: { byStudent: 'studentEmail' } },
  Answers: { pk: 'examStudent', sk: 'questionNumber' },
  Appeals: { pk: 'appealId', indexes: { byExam: 'examId' } },
  AuditLog: { pk: 'entityKey', sk: 'timestamp', indexes: { byActor: 'actor' } },
};

interface ExpressionInput {
  ExpressionAttributeNames?: Record<string, string> | undefined;
  ExpressionAttributeValues?: Record<string, unknown> | undefined;
}

/**
 * A small in-memory DynamoDB over all eight tables, for tests. It understands what the shared
 * data-access modules send: Get, Put (with attribute_not_exists), Update (SET, ADD, REMOVE,
 * if_not_exists, and attribute_exists / attribute_not_exists / equality conditions), Query on a
 * table or index (one equality, an optional sort-key equality, Limit, ScanIndexForward) and Scan.
 */
export class FakeDb {
  private readonly tables = new Map<TableName, Map<string, Item>>();
  private readonly mock = mockClient(DynamoDBDocumentClient);

  constructor() {
    for (const name of TABLE_NAMES) {
      this.tables.set(name, new Map());
      process.env[TABLE_ENV[name]] = name;
    }
    this.install();
  }

  /** Empties every table. */
  reset(): void {
    for (const rows of this.tables.values()) rows.clear();
  }

  /** The Users table, keyed by email. */
  get users(): Map<string, UserItem> {
    return this.rows('Users') as unknown as Map<string, UserItem>;
  }

  /** The Batches table, keyed by batchId. */
  get batches(): Map<string, BatchItem> {
    return this.rows('Batches') as unknown as Map<string, BatchItem>;
  }

  addUser(user: UserItem): UserItem {
    this.users.set(user.email, structuredClone(user));
    return user;
  }

  addBatch(batchId: string, name = `Batch ${batchId}`): void {
    this.batches.set(batchId, { batchId, name });
  }

  /** Inserts an item into any table. */
  put(table: TableName, item: object): void {
    this.rows(table).set(this.storageKey(table, item as Item), structuredClone(item as Item));
  }

  /** Reads an item by its key attributes, e.g. get('Questions', { questionId: 'q', version: 1 }). */
  get<T = Item>(table: TableName, key: Item): T | undefined {
    const item = this.rows(table).get(this.storageKey(table, key));
    return item ? (structuredClone(item) as T) : undefined;
  }

  /** Every item in a table. */
  all<T = Item>(table: TableName): T[] {
    return [...this.rows(table).values()].map((i) => structuredClone(i) as T);
  }

  private rows(table: TableName): Map<string, Item> {
    return this.tables.get(table) as Map<string, Item>;
  }

  private nameOf(physical: string | undefined): TableName {
    if ((TABLE_NAMES as readonly string[]).includes(physical ?? '')) return physical as TableName;
    throw new Error(`FakeDb has no table ${String(physical)}`);
  }

  private storageKey(table: TableName, item: Item): string {
    const def = DEFS[table];
    const parts = [item[def.pk]];
    if (def.sk) parts.push(item[def.sk]);
    return parts.map(String).join('\u0000');
  }

  private install(): void {
    const conditionFailed = () =>
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      });

    this.mock.on(GetCommand).callsFake((input) => {
      const table = this.nameOf(input.TableName);
      const item = this.rows(table).get(this.storageKey(table, input.Key));
      return { Item: item ? structuredClone(item) : undefined };
    });

    this.mock.on(PutCommand).callsFake((input) => {
      const table = this.nameOf(input.TableName);
      const key = this.storageKey(table, input.Item);
      const existing = this.rows(table).get(key);
      if (!this.conditionHolds(input.ConditionExpression, input, existing)) throw conditionFailed();
      this.rows(table).set(key, structuredClone(input.Item));
      return {};
    });

    this.mock.on(UpdateCommand).callsFake((input) => {
      const table = this.nameOf(input.TableName);
      const key = this.storageKey(table, input.Key);
      const existing = this.rows(table).get(key);
      if (!this.conditionHolds(input.ConditionExpression, input, existing)) throw conditionFailed();

      const item: Item = existing ?? { ...structuredClone(input.Key) };
      const changed = this.applyUpdate(item, input.UpdateExpression ?? '', input);
      this.rows(table).set(key, item);

      if (input.ReturnValues === 'UPDATED_NEW') {
        return {
          Attributes: Object.fromEntries(changed.map((a) => [a, structuredClone(item[a])])),
        };
      }
      return {};
    });

    this.mock.on(QueryCommand).callsFake((input) => {
      const table = this.nameOf(input.TableName);
      const def = DEFS[table];
      const match = /^(\S+) = (:\w+)(?: AND (\S+) = (:\w+))?$/.exec(
        input.KeyConditionExpression ?? '',
      );
      if (!match) throw new Error(`FakeDb cannot read ${String(input.KeyConditionExpression)}`);
      const resolve = (n: string) => input.ExpressionAttributeNames?.[n] ?? n;
      const pkAttr = resolve(match[1] as string);
      const pkValue = input.ExpressionAttributeValues?.[match[2] as string];
      const skAttr = match[3] ? resolve(match[3]) : undefined;
      const skValue = match[4] ? input.ExpressionAttributeValues?.[match[4]] : undefined;

      if (input.IndexName) {
        if (def.indexes?.[input.IndexName] !== pkAttr) {
          throw new Error(`FakeDb: index ${input.IndexName} is not keyed by ${pkAttr}`);
        }
      } else if (pkAttr !== def.pk) {
        throw new Error(`FakeDb: ${pkAttr} is not the partition key of ${table}`);
      }

      let items = [...this.rows(table).values()].filter(
        (i) => i[pkAttr] === pkValue && (skAttr === undefined || i[skAttr] === skValue),
      );
      if (def.sk && !input.IndexName) {
        const sk = def.sk;
        const direction = input.ScanIndexForward === false ? -1 : 1;
        items = items.sort((a, b) => {
          const [x, y] = [a[sk] as number | string, b[sk] as number | string];
          return x === y ? 0 : x < y ? -direction : direction;
        });
      }
      if (input.Limit) items = items.slice(0, input.Limit);
      return { Items: items.map((i) => structuredClone(i)) };
    });

    this.mock.on(ScanCommand).callsFake((input) => ({
      Items: [...this.rows(this.nameOf(input.TableName)).values()].map((i) => structuredClone(i)),
    }));
  }

  private conditionHolds(
    condition: string | undefined,
    input: ExpressionInput,
    existing: Item | undefined,
  ): boolean {
    if (!condition) return true;
    const resolve = (n: string) => input.ExpressionAttributeNames?.[n] ?? n;

    return condition.split(' AND ').every((clause) => {
      const trimmed = clause.trim();
      let m = /^attribute_not_exists\((\S+)\)$/.exec(trimmed);
      if (m) return existing?.[resolve(m[1] as string)] === undefined;
      m = /^attribute_exists\((\S+)\)$/.exec(trimmed);
      if (m) return existing?.[resolve(m[1] as string)] !== undefined;
      m = /^(\S+) = (:\w+)$/.exec(trimmed);
      if (m)
        return (
          existing?.[resolve(m[1] as string)] === input.ExpressionAttributeValues?.[m[2] as string]
        );
      throw new Error(`FakeDb cannot evaluate condition "${trimmed}"`);
    });
  }

  /** Applies SET, ADD and REMOVE clauses in place. Returns the attributes that were set or added. */
  private applyUpdate(item: Item, expression: string, input: ExpressionInput): string[] {
    const resolve = (n: string) => input.ExpressionAttributeNames?.[n] ?? n;
    const value = (ref: string) => structuredClone(input.ExpressionAttributeValues?.[ref]);
    const changed: string[] = [];

    const clauses = expression.split(/\b(SET|ADD|REMOVE)\s+/).slice(1);
    for (let i = 0; i < clauses.length; i += 2) {
      const kind = clauses[i];
      const body = (clauses[i + 1] ?? '').trim();
      for (const part of body.split(/,\s*(?![^()]*\))/)) {
        const text = part.trim();
        if (kind === 'REMOVE') {
          delete item[resolve(text)];
        } else if (kind === 'ADD') {
          const [name, ref] = text.split(/\s+/) as [string, string];
          const attr = resolve(name);
          item[attr] = ((item[attr] as number | undefined) ?? 0) + (value(ref) as number);
          changed.push(attr);
        } else {
          const [lhs, rhs] = text.split(/\s*=\s*/) as [string, string];
          const attr = resolve(lhs);
          const guard = /^if_not_exists\((\S+),\s*(:\w+)\)$/.exec(rhs);
          if (guard) {
            if (item[attr] === undefined) item[attr] = value(guard[2] as string);
          } else {
            item[attr] = value(rhs);
          }
          changed.push(attr);
        }
      }
    }
    return changed;
  }
}
