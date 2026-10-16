import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { TABLE_NAMES, type TableName } from '@yulove/shared';
import type { Construct } from 'constructs';

export { TABLE_NAMES, type TableName };

export const GEMINI_SECRET_NAME = 'dsa-judge/gemini-api-key';

export interface DataStackProps extends StackProps {
  webOrigins: string[];
}

interface KeyDef {
  name: string;
  type: AttributeType;
}

interface IndexDef {
  name: string;
  partitionKey: KeyDef;
  sortKey?: KeyDef;
}

interface TableDef {
  partitionKey: KeyDef;
  sortKey?: KeyDef;
  indexes?: IndexDef[];
}

const S = AttributeType.STRING;
const N = AttributeType.NUMBER;

/** Keys and indexes exactly as in the Data model table of docs/DESIGN.md. */
const TABLE_DEFS: Record<TableName, TableDef> = {
  Users: {
    partitionKey: { name: 'email', type: S },
    indexes: [
      { name: 'byBatch', partitionKey: { name: 'batchId', type: S } },
      { name: 'byRoll', partitionKey: { name: 'rollNo', type: S } },
    ],
  },
  Batches: {
    partitionKey: { name: 'batchId', type: S },
  },
  Questions: {
    partitionKey: { name: 'questionId', type: S },
    sortKey: { name: 'version', type: N },
    indexes: [{ name: 'byTeacher', partitionKey: { name: 'teacherEmail', type: S } }],
  },
  Exams: {
    partitionKey: { name: 'examId', type: S },
    indexes: [{ name: 'byBatch', partitionKey: { name: 'batchId', type: S } }],
  },
  ExamStudents: {
    partitionKey: { name: 'examId', type: S },
    sortKey: { name: 'studentEmail', type: S },
    indexes: [{ name: 'byStudent', partitionKey: { name: 'studentEmail', type: S } }],
  },
  Answers: {
    // Partition key value is `${examId}#${studentEmail}`.
    partitionKey: { name: 'examStudent', type: S },
    sortKey: { name: 'questionNumber', type: N },
  },
  Appeals: {
    partitionKey: { name: 'appealId', type: S },
    indexes: [
      {
        name: 'byExam',
        partitionKey: { name: 'examId', type: S },
        sortKey: { name: 'status', type: S },
      },
    ],
  },
  AuditLog: {
    partitionKey: { name: 'entityKey', type: S },
    sortKey: { name: 'timestamp', type: S },
    indexes: [{ name: 'byActor', partitionKey: { name: 'actor', type: S } }],
  },
};

export class DataStack extends Stack {
  readonly tables: Record<TableName, Table>;
  readonly bucket: Bucket;
  readonly geminiApiKeySecret: Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const tables = {} as Record<TableName, Table>;
    for (const name of TABLE_NAMES) {
      const def = TABLE_DEFS[name];
      const table = new Table(this, `${name}Table`, {
        partitionKey: def.partitionKey,
        sortKey: def.sortKey,
        billingMode: BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: RemovalPolicy.RETAIN,
      });
      for (const index of def.indexes ?? []) {
        table.addGlobalSecondaryIndex({
          indexName: index.name,
          partitionKey: index.partitionKey,
          sortKey: index.sortKey,
          projectionType: ProjectionType.ALL,
        });
      }
      new CfnOutput(this, `${name}TableName`, { value: table.tableName });
      tables[name] = table;
    }
    this.tables = tables;

    this.bucket = new Bucket(this, 'Bucket', {
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [HttpMethods.PUT, HttpMethods.POST],
          allowedOrigins: props.webOrigins,
          allowedHeaders: ['*'],
          maxAge: Duration.hours(1).toSeconds(),
        },
      ],
    });
    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });

    // Created with a throwaway generated value; the real key is put there by hand.
    this.geminiApiKeySecret = new Secret(this, 'GeminiApiKeySecret', {
      secretName: GEMINI_SECRET_NAME,
      description: 'Gemini API key. Replace the generated value after the first deploy.',
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
