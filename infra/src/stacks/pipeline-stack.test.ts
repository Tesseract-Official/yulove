import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';

const { templates, pipeline } = buildApp();
const template = templates.pipeline;

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}

interface LambdaProperties {
  Description: string;
  Role: { 'Fn::GetAtt': string[] };
  Environment?: { Variables: Record<string, unknown> };
  [key: string]: unknown;
}

const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

function lambdaFor(description: string) {
  const found = Object.entries(template.findResources('AWS::Lambda::Function')).filter(
    ([, r]) => (r.Properties as LambdaProperties).Description === description,
  );
  if (found.length !== 1) throw new Error(`Expected one Lambda described as "${description}"`);
  return { id: found[0]?.[0] as string, properties: found[0]?.[1].Properties as LambdaProperties };
}

/** Every IAM statement on the role of one Lambda. */
function statementsOf(description: string): Statement[] {
  const roleId = lambdaFor(description).properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

const withPrefix = (statements: Statement[], prefix: string) =>
  statements.filter((s) => actionsOf(s).some((a) => a.startsWith(prefix)));

const TESTGEN = 'Generates test material for a question with Gemini';
const TRANSCRIBE = 'Transcribes an answer photo with Gemini and queues it for the worker';

describe('PipelineStack', () => {
  it('has the test-generation and transcribe Lambdas, both on Node.js 22', () => {
    template.resourceCountIs('AWS::Lambda::Function', 2);
    for (const description of [TESTGEN, TRANSCRIBE]) {
      expect(lambdaFor(description).properties['Runtime']).toBe('nodejs22.x');
    }
  });

  it('exposes both functions', () => {
    expect(pipeline.testGenerationFunction).toBeDefined();
    expect(pipeline.transcribeFunction).toBeDefined();
  });
});

describe('PipelineStack: test-generation Lambda', () => {
  const statements = () => statementsOf(TESTGEN);

  it('has a long timeout and no automatic retries', () => {
    const p = lambdaFor(TESTGEN).properties;
    expect(p['Timeout']).toBe(300);
    expect(p['MemorySize']).toBe(512);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
    });
  });

  it('gets its table, bucket, queue, secret and model from the environment', () => {
    expect(lambdaFor(TESTGEN).properties.Environment?.Variables).toMatchObject({
      QUESTIONS_TABLE: expect.anything(),
      BUCKET_NAME: expect.anything(),
      EXECUTE_QUEUE_URL: expect.anything(),
      GEMINI_SECRET_NAME: 'dsa-judge/gemini-api-key',
      GEMINI_MODEL: 'gemini-testgen-test-model',
    });
  });

  it('can read the Gemini secret and nothing else in Secrets Manager', () => {
    const secret = withPrefix(statements(), 'secretsmanager:');
    expect(secret).toHaveLength(1);
    expect(actionsOf(secret[0] as Statement).sort()).toEqual([
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
    ]);
    expect(JSON.stringify(secret[0]?.Resource)).toContain('GeminiApiKeySecret');
  });

  it('can read and write the Questions table and no other table', () => {
    const tables = withPrefix(statements(), 'dynamodb:');
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
    const s3 = withPrefix(statements(), 's3:');
    expect(s3).toHaveLength(1);
    expect(actionsOf(s3[0] as Statement).sort()).toEqual(['s3:GetObject', 's3:PutObject']);
    const resource = JSON.stringify(s3[0]?.Resource);
    expect(resource).toContain('/questions/*');
    expect(resource).not.toMatch(/answers|exams/);
  });

  it('can send to the execute queue and nothing else in SQS', () => {
    const sqs = withPrefix(statements(), 'sqs:');
    expect(sqs).toHaveLength(1);
    expect(actionsOf(sqs[0] as Statement)).toEqual(expect.arrayContaining(['sqs:SendMessage']));
    expect(actionsOf(sqs[0] as Statement).filter((a) => /Receive|Delete/.test(a))).toEqual([]);
    expect(JSON.stringify(sqs[0]?.Resource)).toContain('executeQueue');
  });

  it('has no other permissions: no Lambda invoke, no wildcard resources', () => {
    expect(withPrefix(statements(), 'lambda:')).toEqual([]);
    for (const s of statements()) {
      expect(JSON.stringify(s.Resource), actionsOf(s).join()).not.toBe('"*"');
    }
    expect(
      statements()
        .map((s) => actionsOf(s)[0]?.split(':')[0])
        .sort(),
    ).toEqual(['dynamodb', 'dynamodb', 's3', 'secretsmanager', 'sqs']);
  });
});

describe('PipelineStack: Transcribe Lambda', () => {
  const statements = () => statementsOf(TRANSCRIBE);

  it('times out after 120 seconds and has 512 MB', () => {
    const p = lambdaFor(TRANSCRIBE).properties;
    expect(p['Timeout']).toBe(120);
    expect(p['MemorySize']).toBe(512);
  });

  it('reserves concurrency 10', () => {
    expect(lambdaFor(TRANSCRIBE).properties['ReservedConcurrentExecutions']).toBe(10);
    // The test-generation function is not limited.
    expect(lambdaFor(TESTGEN).properties).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  it('is triggered by the transcribe queue, one message at a time', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      EventSourceArn: Match.anyValue(),
    });
    const mapping = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))[0];
    expect(JSON.stringify(mapping?.Properties.EventSourceArn)).toContain('transcribeQueue');
    expect(mapping?.Properties).not.toHaveProperty('ScalingConfig');
  });

  it('takes its model from geminiTranscribeModel and its secret from Secrets Manager', () => {
    expect(lambdaFor(TRANSCRIBE).properties.Environment?.Variables).toMatchObject({
      GEMINI_MODEL: 'gemini-transcribe-test-model',
      GEMINI_SECRET_NAME: 'dsa-judge/gemini-api-key',
      ANSWERS_TABLE: expect.anything(),
      QUESTIONS_TABLE: expect.anything(),
      BUCKET_NAME: expect.anything(),
      EXECUTE_QUEUE_URL: expect.anything(),
    });
    // The test-generation function keeps its own model.
    expect(lambdaFor(TESTGEN).properties.Environment?.Variables).toMatchObject({
      GEMINI_MODEL: 'gemini-testgen-test-model',
    });
  });

  it('can read the Gemini secret and nothing else in Secrets Manager', () => {
    const secret = withPrefix(statements(), 'secretsmanager:');
    expect(secret).toHaveLength(1);
    expect(actionsOf(secret[0] as Statement).sort()).toEqual([
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
    ]);
    expect(JSON.stringify(secret[0]?.Resource)).toContain('GeminiApiKeySecret');
  });

  it('can only GetItem and UpdateItem on Answers and GetItem on Questions', () => {
    const tables = withPrefix(statements(), 'dynamodb:');
    const byTable = (name: string) =>
      tables.filter((s) => JSON.stringify(s.Resource).includes(`${name}Table`));

    expect(byTable('Answers').flatMap(actionsOf).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    ]);
    expect(byTable('Questions').flatMap(actionsOf)).toEqual(['dynamodb:GetItem']);
    expect(tables).toHaveLength(2);
    for (const s of tables) {
      expect(JSON.stringify(s.Resource)).not.toContain('/index/');
    }
  });

  it('can only get objects under answers/*', () => {
    const s3 = withPrefix(statements(), 's3:');
    expect(s3).toHaveLength(1);
    expect(actionsOf(s3[0] as Statement)).toEqual(['s3:GetObject']);
    const resource = JSON.stringify(s3[0]?.Resource);
    expect(resource).toContain('/answers/*');
    expect(resource).not.toMatch(/questions|exams/);
  });

  it('can receive from the transcribe queue and send to the execute queue, nothing else', () => {
    const sqs = withPrefix(statements(), 'sqs:');
    const forQueue = (name: string) =>
      sqs.filter((s) => JSON.stringify(s.Resource).includes(`${name}Queue`));

    expect(sqs).toHaveLength(2);
    const consume = forQueue('transcribe').flatMap(actionsOf);
    expect(consume).toEqual(
      expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes']),
    );
    expect(consume).not.toContain('sqs:SendMessage');
    const send = forQueue('execute').flatMap(actionsOf);
    expect(send).toContain('sqs:SendMessage');
    expect(send.filter((a) => /Receive|Delete/.test(a))).toEqual([]);
  });

  it('has no other permissions: no Lambda invoke, no wildcard resources', () => {
    expect(withPrefix(statements(), 'lambda:')).toEqual([]);
    for (const s of statements()) {
      expect(JSON.stringify(s.Resource), actionsOf(s).join()).not.toBe('"*"');
    }
    const services = new Set(statements().map((s) => actionsOf(s)[0]?.split(':')[0]));
    expect([...services].sort()).toEqual(['dynamodb', 's3', 'secretsmanager', 'sqs']);
  });
});
