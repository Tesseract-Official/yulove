import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';

const { templates } = buildApp();
const template = templates.pipeline;

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}

const statements = (): Statement[] =>
  Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (p) => p.Properties.PolicyDocument.Statement as Statement[],
  );
const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const statementsFor = (prefix: string) =>
  statements().filter((s) => actionsOf(s).some((a) => a.startsWith(prefix)));

describe('PipelineStack: test-generation Lambda', () => {
  it('is a single Node.js 22 function with a long timeout and no automatic retries', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 300,
      MemorySize: 512,
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
    });
  });

  it('gets its table, bucket, queue, secret and model from the environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          QUESTIONS_TABLE: Match.anyValue(),
          BUCKET_NAME: Match.anyValue(),
          EXECUTE_QUEUE_URL: Match.anyValue(),
          GEMINI_SECRET_NAME: 'dsa-judge/gemini-api-key',
          GEMINI_MODEL: 'gemini-testgen-test-model',
        },
      },
    });
  });

  it('can read the Gemini secret and nothing else in Secrets Manager', () => {
    const secret = statementsFor('secretsmanager:');
    expect(secret).toHaveLength(1);
    expect(actionsOf(secret[0] as Statement).sort()).toEqual([
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
    ]);
    expect(JSON.stringify(secret[0]?.Resource)).toContain('GeminiApiKeySecret');
  });

  it('can read and write the Questions table and no other table', () => {
    // CDK writes the table grant as two statements (data actions, then stream actions).
    const tables = statementsFor('dynamodb:');
    expect(tables.length).toBeGreaterThan(0);
    for (const statement of tables) {
      const resources = JSON.stringify(statement.Resource);
      expect(resources).toContain('QuestionsTable');
      for (const other of [
        'Users',
        'Batches',
        'Exams',
        'ExamStudents',
        'Answers',
        'Appeals',
        'AuditLog',
      ]) {
        expect(resources, other).not.toContain(`${other}Table`);
      }
    }
    expect(tables.flatMap(actionsOf)).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']),
    );
  });

  it('can get and put objects under questions/* only', () => {
    const s3 = statementsFor('s3:');
    expect(s3).toHaveLength(1);
    expect(actionsOf(s3[0] as Statement).sort()).toEqual(['s3:GetObject', 's3:PutObject']);
    const resource = JSON.stringify(s3[0]?.Resource);
    expect(resource).toContain('/questions/*');
    expect(resource).not.toMatch(/answers|exams/);
  });

  it('can send to the execute queue and nothing else in SQS', () => {
    const sqs = statementsFor('sqs:');
    expect(sqs).toHaveLength(1);
    expect(actionsOf(sqs[0] as Statement)).toEqual(expect.arrayContaining(['sqs:SendMessage']));
    expect(actionsOf(sqs[0] as Statement).filter((a) => /Receive|Delete/.test(a))).toEqual([]);
    expect(JSON.stringify(sqs[0]?.Resource)).toContain('executeQueue');
  });

  it('has no other permissions: no Lambda invoke, no wildcard resources', () => {
    expect(statementsFor('lambda:')).toEqual([]);
    for (const s of statements()) {
      expect(JSON.stringify(s.Resource), actionsOf(s).join()).not.toBe('"*"');
    }
    // Only the grants above: secret, table (two statements, both on Questions), objects, queue.
    expect(
      statements()
        .map((s) => actionsOf(s)[0]?.split(':')[0])
        .sort(),
    ).toEqual(['dynamodb', 'dynamodb', 's3', 'secretsmanager', 'sqs']);
  });
});
