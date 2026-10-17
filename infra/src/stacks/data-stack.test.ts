import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';
import { GEMINI_SECRET_NAME, TABLE_NAMES } from './data-stack.js';

interface Key {
  name: string;
  type: 'S' | 'N';
}
interface ExpectedTable {
  pk: Key;
  sk?: Key;
  gsis: Record<string, { pk: Key; sk?: Key }>;
}

const S = (name: string): Key => ({ name, type: 'S' });
const N = (name: string): Key => ({ name, type: 'N' });

// Written out by hand from the Data model table in docs/DESIGN.md, not derived from the stack.
const EXPECTED: Record<string, ExpectedTable> = {
  Users: {
    pk: S('email'),
    gsis: { byBatch: { pk: S('batchId') }, byRoll: { pk: S('rollNo') } },
  },
  Batches: { pk: S('batchId'), gsis: {} },
  Questions: {
    pk: S('questionId'),
    sk: N('version'),
    gsis: { byTeacher: { pk: S('teacherEmail') } },
  },
  Exams: { pk: S('examId'), gsis: { byBatch: { pk: S('batchId') } } },
  ExamStudents: {
    pk: S('examId'),
    sk: S('studentEmail'),
    gsis: { byStudent: { pk: S('studentEmail') } },
  },
  Answers: { pk: S('examStudent'), sk: N('questionNumber'), gsis: {} },
  Appeals: {
    pk: S('appealId'),
    gsis: { byExam: { pk: S('examId'), sk: S('status') } },
  },
  AuditLog: {
    pk: S('entityKey'),
    sk: S('timestamp'),
    gsis: { byActor: { pk: S('actor') } },
  },
};

const { data, templates } = buildApp();
const template = templates.data;

function tableProps(logicalName: string) {
  const resources = template.findResources('AWS::DynamoDB::Table');
  const entry = Object.entries(resources).find(([id]) => id.startsWith(`${logicalName}Table`));
  if (!entry) throw new Error(`No table resource for ${logicalName}`);
  return entry[1].Properties as {
    KeySchema: { AttributeName: string; KeyType: string }[];
    AttributeDefinitions: { AttributeName: string; AttributeType: string }[];
    GlobalSecondaryIndexes?: {
      IndexName: string;
      KeySchema: { AttributeName: string; KeyType: string }[];
      Projection: { ProjectionType: string };
    }[];
    BillingMode: string;
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: boolean };
  };
}

describe('DataStack tables', () => {
  it('has exactly the eight tables from the data model', () => {
    expect(TABLE_NAMES).toHaveLength(8);
    expect(Object.keys(EXPECTED).sort()).toEqual([...TABLE_NAMES].sort());
    template.resourceCountIs('AWS::DynamoDB::Table', 8);
    expect(Object.keys(data.tables).sort()).toEqual([...TABLE_NAMES].sort());
  });

  describe.each(Object.entries(EXPECTED))('%s', (name, expected) => {
    const props = tableProps(name);
    const typeOf = (attr: string) =>
      props.AttributeDefinitions.find((a) => a.AttributeName === attr)?.AttributeType;

    it('has the expected primary key and types', () => {
      const keys = [
        { AttributeName: expected.pk.name, KeyType: 'HASH' },
        ...(expected.sk ? [{ AttributeName: expected.sk.name, KeyType: 'RANGE' }] : []),
      ];
      expect(props.KeySchema).toEqual(keys);
      expect(typeOf(expected.pk.name)).toBe(expected.pk.type);
      if (expected.sk) expect(typeOf(expected.sk.name)).toBe(expected.sk.type);
    });

    it('has exactly the expected indexes', () => {
      const actual = props.GlobalSecondaryIndexes ?? [];
      expect(actual.map((g) => g.IndexName).sort()).toEqual(Object.keys(expected.gsis).sort());
      for (const gsi of actual) {
        const want = expected.gsis[gsi.IndexName];
        if (!want) throw new Error(`Unexpected index ${gsi.IndexName}`);
        expect(gsi.KeySchema).toEqual([
          { AttributeName: want.pk.name, KeyType: 'HASH' },
          ...(want.sk ? [{ AttributeName: want.sk.name, KeyType: 'RANGE' }] : []),
        ]);
        expect(typeOf(want.pk.name)).toBe(want.pk.type);
        if (want.sk) expect(typeOf(want.sk.name)).toBe(want.sk.type);
        expect(gsi.Projection.ProjectionType).toBe('ALL');
      }
    });

    it('is on-demand with point-in-time recovery', () => {
      expect(props.BillingMode).toBe('PAY_PER_REQUEST');
      expect(props.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    });
  });

  it('retains every table on stack deletion', () => {
    for (const resource of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
      expect(resource['DeletionPolicy']).toBe('Retain');
    }
  });
});

describe('DataStack bucket', () => {
  it('is the only bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('is versioned and encrypted', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  it('allows PUT and POST from the web origin only', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['PUT', 'POST'],
            AllowedOrigins: ['https://app.college.edu'],
          }),
        ],
      },
    });
  });

  it('is retained on stack deletion', () => {
    for (const resource of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect(resource['DeletionPolicy']).toBe('Retain');
    }
  });
});

describe('DataStack secrets', () => {
  it('creates the Gemini API key secret', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: GEMINI_SECRET_NAME });
    expect(GEMINI_SECRET_NAME).toBe('dsa-judge/gemini-api-key');
  });
});

describe('DataStack outputs', () => {
  it('exports the Users table name, which pnpm seed:super-admins reads', () => {
    const outputs = template.toJSON().Outputs as Record<string, unknown>;
    expect(Object.keys(outputs)).toContain('UsersTableName');
  });
});
