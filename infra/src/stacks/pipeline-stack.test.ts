import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';
import { RECORD_MAX_CONCURRENCY, TRANSCRIBE_MAX_CONCURRENCY } from './pipeline-stack.js';

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

/** The trigger that reads one queue. */
function mappingFor(queue: 'transcribe' | 'results') {
  const found = Object.values(template.findResources('AWS::Lambda::EventSourceMapping')).filter(
    (m) => JSON.stringify(m.Properties.EventSourceArn).includes(`${queue}Queue`),
  );
  if (found.length !== 1) throw new Error(`Expected one trigger for the ${queue} queue`);
  return found[0]!;
}

const RECORD = 'Records worker results: answer scores, totals and question test setup';
const TESTGEN = 'Generates test material for a question with Gemini';
const TRANSCRIBE = 'Transcribes an answer photo with Gemini and queues it for the worker';

describe('PipelineStack', () => {
  it('has the test-generation and transcribe Lambdas, both on Node.js 22', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
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

  it('has a long timeout and two asynchronous retries (for a busy Gemini)', () => {
    const p = lambdaFor(TESTGEN).properties;
    expect(p['Timeout']).toBe(300);
    expect(p['MemorySize']).toBe(512);
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
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

  it('cannot delete or batch-write anything in DynamoDB', () => {
    const actions = withPrefix(statements(), 'dynamodb:').flatMap(actionsOf);
    expect(actions.filter((a) => /Delete|BatchWrite/.test(a))).toEqual([]);
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
    ).toEqual(['dynamodb', 'dynamodb', 'dynamodb', 's3', 'secretsmanager', 'sqs']);
  });
});

describe('PipelineStack: Transcribe Lambda', () => {
  const statements = () => statementsOf(TRANSCRIBE);

  it('times out after 120 seconds and has 512 MB', () => {
    const p = lambdaFor(TRANSCRIBE).properties;
    expect(p['Timeout']).toBe(120);
    expect(p['MemorySize']).toBe(512);
  });

  it('reserves no concurrency (the account quota is too low); the queue trigger caps it at 5', () => {
    expect(lambdaFor(TRANSCRIBE).properties).not.toHaveProperty('ReservedConcurrentExecutions');
    expect(TRANSCRIBE_MAX_CONCURRENCY).toBe(5);
    expect(mappingFor('transcribe').Properties.ScalingConfig).toEqual({ MaximumConcurrency: 5 });
  });

  it('is triggered by the transcribe queue, one message at a time', () => {
    expect(mappingFor('transcribe').Properties.BatchSize).toBe(1);
    expect(JSON.stringify(mappingFor('transcribe').Properties.FunctionName)).toContain(
      'TranscribeFunction',
    );
  });

  it('does not report partial batch failures: a thrown error returns the whole one-message batch', () => {
    for (const queue of ['transcribe', 'results'] as const) {
      expect(mappingFor(queue).Properties).not.toHaveProperty('FunctionResponseTypes');
      expect(mappingFor(queue).Properties.BatchSize).toBe(1);
    }
  });

  it('has no automatic retries of its own: SQS redelivers instead', () => {
    // Only the test-generation function has an asynchronous invoke config.
    const configs = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'));
    expect(configs).toHaveLength(1);
    expect(JSON.stringify(configs[0]?.Properties.FunctionName)).toContain('TestGenerationFunction');
  });

  it('takes its model from geminiTranscribeModel and its secret from Secrets Manager', () => {
    expect(lambdaFor(TRANSCRIBE).properties.Environment?.Variables).toMatchObject({
      GEMINI_MODEL: 'gemini-transcribe-test-model',
      GEMINI_SECRET_NAME: 'dsa-judge/gemini-api-key',
      ANSWERS_TABLE: expect.anything(),
      QUESTIONS_TABLE: expect.anything(),
      BUCKET_NAME: expect.anything(),
      EXECUTE_QUEUE_URL: expect.anything(),
      TRANSCRIBE_QUEUE_URL: expect.anything(),
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
    // It can hide a message for longer or shorter (ChangeMessageVisibility) on this queue only.
    expect(consume).toContain('sqs:ChangeMessageVisibility');
    expect(
      sqs
        .filter((s) => actionsOf(s).includes('sqs:ChangeMessageVisibility'))
        .every((s) => JSON.stringify(s.Resource).includes('transcribeQueue')),
    ).toBe(true);
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

describe('PipelineStack: Record Lambda', () => {
  const statements = () => statementsOf(RECORD);
  const forTable = (name: string) =>
    withPrefix(statements(), 'dynamodb:').filter((s) =>
      JSON.stringify(s.Resource).includes(`${name}Table`),
    );

  it('times out after 30 seconds, and reserves no concurrency', () => {
    const p = lambdaFor(RECORD).properties;
    expect(p['Timeout']).toBe(30);
    expect(p['MemorySize']).toBe(256);
    expect(p).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  it('is triggered by the results queue, one message at a time, at most 2 at once', () => {
    const mapping = mappingFor('results');
    expect(JSON.stringify(mapping.Properties.FunctionName)).toContain('RecordFunction');
    expect(mapping.Properties.BatchSize).toBe(1);
    expect(mapping.Properties.ScalingConfig).toEqual({ MaximumConcurrency: 2 });
    expect(RECORD_MAX_CONCURRENCY).toBe(2);
  });

  it('gets its four tables and the test-generation function name from the environment', () => {
    expect(lambdaFor(RECORD).properties.Environment?.Variables).toMatchObject({
      ANSWERS_TABLE: expect.anything(),
      EXAMS_TABLE: expect.anything(),
      EXAM_STUDENTS_TABLE: expect.anything(),
      QUESTIONS_TABLE: expect.anything(),
      TESTGEN_FUNCTION_NAME: expect.anything(),
    });
  });

  it('has exactly the table actions it needs on each of four tables', () => {
    expect(forTable('Answers').flatMap(actionsOf).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ]);
    expect(forTable('Exams').flatMap(actionsOf)).toEqual(['dynamodb:GetItem']);
    expect(forTable('ExamStudents').flatMap(actionsOf).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    ]);
    expect(forTable('Questions').flatMap(actionsOf).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    ]);
    // Nothing on any other table (Users, Batches, Appeals, AuditLog) and no PutItem/Delete.
    expect(withPrefix(statements(), 'dynamodb:')).toHaveLength(4);
    expect(withPrefix(statements(), 'dynamodb:').flatMap(actionsOf)).not.toContain(
      'dynamodb:PutItem',
    );
  });

  it('can receive from the results queue and send nothing', () => {
    const sqs = withPrefix(statements(), 'sqs:');
    expect(sqs).toHaveLength(1);
    expect(JSON.stringify(sqs[0]?.Resource)).toContain('resultsQueue');
    expect(actionsOf(sqs[0] as Statement)).toEqual(
      expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
    );
    expect(actionsOf(sqs[0] as Statement)).not.toContain('sqs:SendMessage');
  });

  it('can invoke only the test-generation function', () => {
    const invoke = withPrefix(statements(), 'lambda:');
    expect(invoke).toHaveLength(1);
    expect(actionsOf(invoke[0] as Statement)).toEqual(['lambda:InvokeFunction']);
    expect(JSON.stringify(invoke[0]?.Resource)).toContain('TestGenerationFunction');
    expect(JSON.stringify(invoke[0]?.Resource)).not.toMatch(/"\*"/);
  });

  it('has no S3, secret or other permissions', () => {
    const services = new Set(statements().map((s) => actionsOf(s)[0]?.split(':')[0]));
    expect([...services].sort()).toEqual(['dynamodb', 'lambda', 'sqs']);
    for (const s of statements()) {
      expect(JSON.stringify(s.Resource), actionsOf(s).join()).not.toBe('"*"');
    }
  });
});
