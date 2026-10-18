// A small in-memory stand-in for the DynamoDB and S3 calls the dev-data scripts make, for tests.
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { Aws, DevTables, Item } from './dev-data.js';

export const TABLES: DevTables = {
  users: 'Users',
  batches: 'Batches',
  questions: 'Questions',
  exams: 'Exams',
  examStudents: 'ExamStudents',
  answers: 'Answers',
  appeals: 'Appeals',
};

/** Key attribute names of each table, and the partition attribute of its indexes. */
const KEYS: Record<string, { keys: string[]; indexes: Record<string, string> }> = {
  Users: { keys: ['email'], indexes: { byBatch: 'batchId' } },
  Batches: { keys: ['batchId'], indexes: {} },
  Questions: { keys: ['questionId', 'version'], indexes: {} },
  Exams: { keys: ['examId'], indexes: { byBatch: 'batchId' } },
  ExamStudents: { keys: ['examId', 'studentEmail'], indexes: {} },
  Answers: { keys: ['examStudent', 'questionNumber'], indexes: {} },
  Appeals: { keys: ['appealId'], indexes: { byExam: 'examId' } },
};

export interface S3Object {
  Key: string;
  VersionId: string;
  deleteMarker?: boolean;
}

export class FakeAws {
  readonly rows: Record<string, Item[]> = Object.fromEntries(Object.keys(KEYS).map((t) => [t, []]));
  readonly objects: S3Object[] = [];
  /** Every write the scripts made, in order. */
  readonly writes: Array<{ command: string; table?: string; key?: Item; input: Item }> = [];
  readonly ddbMock = mockClient(DynamoDBDocumentClient);
  readonly s3Mock = mockClient(S3Client);
  readonly aws: Aws;
  /** How many objects one ListObjectVersions page returns (to test paging). */
  pageSize = 1000;

  constructor() {
    this.aws = {
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' })),
      s3: new S3Client({ region: 'ap-south-1' }),
      bucket: 'bucket',
      tables: TABLES,
    };
    this.install();
  }

  reset(): void {
    for (const rows of Object.values(this.rows)) rows.length = 0;
    this.objects.length = 0;
    this.writes.length = 0;
    this.pageSize = 1000;
  }

  put(table: keyof DevTables, item: Item): void {
    this.rows[TABLES[table]]?.push(structuredClone(item));
  }

  all(table: keyof DevTables): Item[] {
    return this.rows[TABLES[table]] ?? [];
  }

  private find(table: string, key: Item): Item | undefined {
    const names = KEYS[table]?.keys ?? [];
    return this.rows[table]?.find((row) => names.every((n) => row[n] === key[n]));
  }

  private install(): void {
    const failed = () =>
      new ConditionalCheckFailedException({ message: 'condition', $metadata: {} });

    this.ddbMock.on(ScanCommand).callsFake((input) => ({
      // Like a careless server: every row, so the script's own flag check is what is tested.
      Items: structuredClone(this.rows[input.TableName as string] ?? []),
    }));

    this.ddbMock.on(GetCommand).callsFake((input) => {
      const found = this.find(input.TableName, input.Key);
      return { Item: found ? structuredClone(found) : undefined };
    });

    this.ddbMock.on(QueryCommand).callsFake((input) => {
      const table = input.TableName as string;
      const attr = /^(\S+) = (:\w+)/.exec(input.KeyConditionExpression ?? '');
      if (!attr) throw new Error(`cannot read ${String(input.KeyConditionExpression)}`);
      const wanted = input.ExpressionAttributeValues?.[attr[2] as string];
      return {
        Items: structuredClone(
          (this.rows[table] ?? []).filter((r) => r[attr[1] as string] === wanted),
        ),
      };
    });

    this.ddbMock.on(UpdateCommand).callsFake((input) => {
      const found = this.find(input.TableName, input.Key);
      this.writes.push({ command: 'update', table: input.TableName, key: input.Key, input });
      const condition: string = input.ConditionExpression ?? '';
      if (!found) throw failed();
      if (condition.includes('#role = :student') && found['role'] !== 'STUDENT') throw failed();
      found['dev'] = true;
      return {};
    });

    this.ddbMock.on(DeleteCommand).callsFake((input) => {
      const table = input.TableName as string;
      const found = this.find(table, input.Key);
      this.writes.push({ command: 'delete', table, key: input.Key, input });
      const condition: string = input.ConditionExpression ?? '';
      if (!found) throw failed();
      if (condition.includes('#dev = :true') && found['dev'] !== true) throw failed();
      if (condition.includes('#role <> :admin') && found['role'] === 'SUPER_ADMIN') throw failed();
      this.rows[table] = (this.rows[table] ?? []).filter((r) => r !== found);
      return {};
    });

    // Pages are cut at key boundaries, like S3's key markers, so deleting a page does not shift the next.
    this.s3Mock.on(ListObjectVersionsCommand).callsFake((input) => {
      const matching = this.objects
        .filter((o) => o.Key.startsWith(input.Prefix as string))
        .filter((o) => !input.KeyMarker || o.Key > (input.KeyMarker as string))
        .sort((a, b) => a.Key.localeCompare(b.Key));
      const page = matching.slice(0, this.pageSize);
      const more = matching.length > this.pageSize;
      return {
        Versions: page
          .filter((o) => !o.deleteMarker)
          .map((o) => ({ Key: o.Key, VersionId: o.VersionId })),
        DeleteMarkers: page
          .filter((o) => o.deleteMarker)
          .map((o) => ({ Key: o.Key, VersionId: o.VersionId })),
        IsTruncated: more,
        NextKeyMarker: more ? page[page.length - 1]?.Key : undefined,
      };
    });

    this.s3Mock.on(DeleteObjectsCommand).callsFake((input) => {
      this.writes.push({ command: 's3-delete', input: input as unknown as Item });
      const gone = (input.Delete?.Objects ?? []) as Array<{ Key: string; VersionId?: string }>;
      for (const g of gone) {
        const at = this.objects.findIndex((o) => o.Key === g.Key && o.VersionId === g.VersionId);
        if (at >= 0) this.objects.splice(at, 1);
      }
      return { Errors: [] };
    });
  }
}
