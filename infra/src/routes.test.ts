import type { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { IMPORT_META_URL_SHIM, ROUTES } from './routes.js';
import { buildApp } from './testing.js';

type Access = 'none' | 'read' | 'readWrite' | 'write';

interface Expected {
  routeKey: string;
  /** Access per table; any table not listed must be 'none'. */
  tables: Partial<Record<string, Access>>;
  collegeDomain?: boolean;
  /** The route's access to the bucket: exactly these S3 actions on this key pattern. */
  bucket?: { actions: string[]; pattern: string; listBucket?: boolean };
  /** The route may send messages to exactly this queue (and its URL is in the environment). */
  sendsTo?: 'transcribe';
  /** The route may invoke the test-generation Lambda, and no other function. */
  invokesTestGeneration?: boolean;
}

// Written by hand: what each route's Lambda may do. Every route reads Users (requireUser).
const EXPECTED: Expected[] = [
  { routeKey: 'GET /me', tables: { Users: 'read', Batches: 'read' } },
  { routeKey: 'GET /batches', tables: { Users: 'read', Batches: 'read' } },
  { routeKey: 'GET /staff', tables: { Users: 'read' } },
  { routeKey: 'GET /exams', tables: { Users: 'read', Exams: 'read' } },
  { routeKey: 'POST /staff', tables: { Users: 'readWrite', Batches: 'read' } },
  { routeKey: 'PUT /staff/{email}/batches', tables: { Users: 'readWrite', Batches: 'read' } },
  { routeKey: 'PUT /users/{email}/active', tables: { Users: 'readWrite' } },
  { routeKey: 'POST /batches', tables: { Users: 'read', Batches: 'write' } },
  {
    routeKey: 'POST /batches/{batchId}/students/import',
    tables: { Users: 'readWrite', Batches: 'read' },
    collegeDomain: true,
  },
  { routeKey: 'GET /batches/{batchId}/students', tables: { Users: 'read', Batches: 'read' } },
  { routeKey: 'GET /questions', tables: { Users: 'read', Questions: 'read', Exams: 'read' } },
  {
    routeKey: 'GET /questions/{id}',
    tables: { Users: 'read', Questions: 'read', Exams: 'read', Answers: 'read' },
  },
  {
    routeKey: 'GET /exams/{id}',
    tables: {
      Users: 'read',
      Exams: 'read',
      ExamStudents: 'read',
      Answers: 'read',
      Questions: 'read',
    },
  },
  { routeKey: 'POST /questions', tables: { Users: 'read', Questions: 'write' } },
  {
    routeKey: 'PUT /questions/{id}',
    tables: { Users: 'read', Questions: 'readWrite', Exams: 'read', Answers: 'read' },
  },
  {
    routeKey: 'POST /questions/{id}/generate-tests',
    tables: { Users: 'read', Questions: 'readWrite', Exams: 'read', Answers: 'read' },
    invokesTestGeneration: true,
  },
  {
    routeKey: 'GET /questions/{id}/tests',
    tables: { Users: 'read', Questions: 'read' },
    bucket: { actions: ['s3:GetObject'], pattern: 'questions/*', listBucket: true },
  },
  { routeKey: 'POST /questions/{id}/approve', tables: { Users: 'read', Questions: 'readWrite' } },
  {
    routeKey: 'POST /exams',
    tables: {
      Users: 'read',
      Batches: 'read',
      Questions: 'read',
      Exams: 'write',
      ExamStudents: 'write',
    },
  },
  {
    routeKey: 'PUT /exams/{id}',
    tables: {
      Users: 'read',
      Batches: 'read',
      Questions: 'read',
      Exams: 'readWrite',
      ExamStudents: 'read',
      Answers: 'read',
    },
  },
  {
    routeKey: 'POST /exams/{id}/pdf',
    tables: { Users: 'read', Batches: 'read', Questions: 'read', Exams: 'readWrite' },
    bucket: { actions: ['s3:PutObject'], pattern: 'exams/*' },
  },
  {
    routeKey: 'GET /exams/{id}/pdf',
    tables: { Users: 'read', Exams: 'read' },
    bucket: { actions: ['s3:GetObject'], pattern: 'exams/*' },
  },
  {
    routeKey: 'POST /answers/upload-url',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite' },
    // The presigned upload is signed with this role, so it may put objects under answers/.
    bucket: { actions: ['s3:PutObject'], pattern: 'answers/*' },
  },
  {
    routeKey: 'POST /answers/submit',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite', Answers: 'write' },
    bucket: { actions: ['s3:GetObject'], pattern: 'answers/*', listBucket: true },
    sendsTo: 'transcribe',
  },
  {
    routeKey: 'GET /exams/{id}/answers',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'read', Answers: 'read' },
  },
  {
    routeKey: 'PUT /exams/{id}/students/{email}/absent',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite', Answers: 'read' },
  },
  {
    routeKey: 'POST /exams/{id}/publish',
    tables: { Users: 'read', Exams: 'readWrite', ExamStudents: 'readWrite', Answers: 'read' },
  },
  {
    routeKey: 'GET /exams/{id}/results',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'read', Answers: 'read' },
  },
  {
    routeKey: 'GET /answers/{examId}/{studentEmail}/{q}',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'read', Answers: 'read' },
    bucket: { actions: ['s3:GetObject'], pattern: 'answers/*' },
  },
  {
    routeKey: 'POST /answers/{examId}/{studentEmail}/{q}/rerun',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite', Answers: 'readWrite' },
    bucket: { actions: ['s3:GetObject'], pattern: 'answers/*', listBucket: true },
    sendsTo: 'transcribe',
  },
  {
    routeKey: 'POST /appeals',
    tables: {
      Users: 'read',
      Exams: 'read',
      ExamStudents: 'read',
      Answers: 'readWrite',
      Appeals: 'readWrite',
    },
  },
  { routeKey: 'GET /appeals', tables: { Users: 'read', Exams: 'read', Appeals: 'read' } },
  {
    routeKey: 'PUT /appeals/{id}',
    tables: {
      Users: 'read',
      Exams: 'read',
      ExamStudents: 'readWrite',
      Answers: 'readWrite',
      Appeals: 'readWrite',
    },
    bucket: { actions: ['s3:GetObject'], pattern: 'answers/*', listBucket: true },
    sendsTo: 'transcribe',
  },
  {
    routeKey: 'PUT /answers/{examId}/{studentEmail}/{q}/override',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite', Answers: 'readWrite' },
  },
  {
    // The only route that reads the audit log (all of them may append to it).
    routeKey: 'GET /answers/{examId}/{studentEmail}/{q}/audit',
    tables: { Users: 'read', Exams: 'read', Answers: 'read', AuditLog: 'read' },
  },
  {
    routeKey: 'GET /me/exams',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'read', Answers: 'read' },
  },
  {
    routeKey: 'GET /me/exams/{id}',
    tables: {
      Users: 'read',
      Exams: 'read',
      ExamStudents: 'read',
      Answers: 'read',
      Questions: 'read',
      Appeals: 'read',
    },
  },
  {
    routeKey: 'GET /me/exams/{id}/questions/{q}/photo',
    tables: { Users: 'read', Exams: 'read', ExamStudents: 'read', Answers: 'read' },
    bucket: { actions: ['s3:GetObject'], pattern: 'answers/*' },
  },
];

const TABLES = [
  'Users',
  'Batches',
  'Questions',
  'Exams',
  'ExamStudents',
  'Answers',
  'Appeals',
  'AuditLog',
];

const WRITE_ACTIONS = /dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/;
const READ_ACTIONS = /dynamodb:(GetItem|Query|Scan|BatchGetItem)/;

interface Statement {
  Action: string | string[];
  Resource: unknown;
}

interface LambdaProperties {
  Runtime: string;
  Role: { 'Fn::GetAtt': string[] };
  Environment?: { Variables: Record<string, string> };
}

function lambdaFor(template: Template, routeKey: string) {
  const functions = template.findResources('AWS::Lambda::Function', {
    Properties: { Description: routeKey },
  });
  const [entry] = Object.entries(functions);
  if (!entry || Object.keys(functions).length !== 1) {
    throw new Error(`Expected exactly one Lambda for ${routeKey}`);
  }
  return { id: entry[0], properties: entry[1].Properties as LambdaProperties };
}

/** Every IAM statement attached to the role of the Lambda for this route. */
function statementsFor(template: Template, routeKey: string): Statement[] {
  const roleId = lambdaFor(template, routeKey).properties.Role['Fn::GetAtt'][0] as string;
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

function accessTo(statements: Statement[], tableLogicalName: string): Access {
  const forTable = statements.filter((s) => JSON.stringify(s.Resource).includes(tableLogicalName));
  const actions = forTable.flatMap(actionsOf);
  const read = actions.some((a) => READ_ACTIONS.test(a));
  const write = actions.some((a) => WRITE_ACTIONS.test(a));
  if (read && write) return 'readWrite';
  if (read) return 'read';
  if (write) return 'write';
  return 'none';
}

const { templates } = buildApp(undefined, { routes: true });
const template = templates.api;

describe('registered routes', () => {
  it('are exactly the expected routes', () => {
    expect(ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      EXPECTED.map((e) => e.routeKey).sort(),
    );
    template.resourceCountIs('AWS::ApiGatewayV2::Route', EXPECTED.length);
  });

  describe('the exam PDF Lambda', () => {
    it('has 512 MB and just under API Gateway’s 30 second limit', () => {
      const { properties } = lambdaFor(template, 'POST /exams/{id}/pdf') as unknown as {
        properties: { MemorySize: number; Timeout: number };
      };
      expect(properties.MemorySize).toBe(512);
      expect(properties.Timeout).toBe(29);
    });

    it('is bundled with the fonts and with the shim PDFKit needs in a CommonJS bundle', () => {
      const route = ROUTES.find((r) => r.path === '/exams/{id}/pdf' && r.method === 'POST');
      expect(route?.options?.assets).toEqual([{ from: 'services/api/assets/fonts', to: 'fonts' }]);
      expect(route?.options?.bundling).toBe(IMPORT_META_URL_SHIM);
      expect(IMPORT_META_URL_SHIM.define).toEqual({ 'import.meta.url': 'import_meta_url' });
      expect(IMPORT_META_URL_SHIM.banner).toContain('import_meta_url');
    });

    it('is the only exam route that writes to the bucket', () => {
      for (const routeKey of ['POST /exams', 'PUT /exams/{id}', 'GET /exams/{id}/pdf']) {
        const actions = statementsFor(template, routeKey).flatMap(actionsOf);
        expect(actions.filter((a) => a === 's3:PutObject')).toEqual([]);
      }
    });
  });

  describe.each(EXPECTED)('$routeKey', (expected) => {
    const { routeKey } = expected;

    it('is protected by the JWT authorizer', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'JWT',
      });
    });

    it('runs on Node.js 22', () => {
      expect(lambdaFor(template, routeKey).properties.Runtime).toBe('nodejs22.x');
    });

    it('has exactly the table access it needs, and none on the other tables', () => {
      const statements = statementsFor(template, routeKey);
      for (const table of TABLES) {
        // Every route may add to the audit log (see the next test); nothing else on it.
        const want =
          table === 'AuditLog'
            ? expected.tables['AuditLog'] === 'read'
              ? 'readWrite'
              : 'write'
            : (expected.tables[table] ?? 'none');
        expect(accessTo(statements, `${table}Table`), table).toBe(want);
      }
    });

    it(
      expected.tables['AuditLog'] === 'read'
        ? 'can append to the audit log and read it (the one route that may)'
        : 'can only PutItem on the audit log: no reads, updates, deletes or batch writes',
      () => {
        const statements = statementsFor(template, routeKey).filter((s) =>
          JSON.stringify(s.Resource).includes('AuditLogTable'),
        );
        const actions = statements.flatMap(actionsOf);
        if (expected.tables['AuditLog'] === 'read') {
          expect(actions).toContain('dynamodb:PutItem');
          expect(actions.filter((a) => /Update|Delete|BatchWrite/.test(a))).toEqual([]);
          return;
        }
        expect(actions).toEqual(['dynamodb:PutItem']);
        expect(JSON.stringify(statements.map((s) => s.Resource))).not.toContain('index');
      },
    );

    it('cannot touch secrets', () => {
      const actions = statementsFor(template, routeKey).flatMap(actionsOf);
      expect(actions.filter((a) => /^secretsmanager:/.test(a))).toEqual([]);
    });

    it(
      expected.sendsTo
        ? `can only send messages to the ${expected.sendsTo} queue`
        : 'cannot touch queues',
      () => {
        const sqs = statementsFor(template, routeKey).filter((s) =>
          actionsOf(s).some((a) => a.startsWith('sqs:')),
        );
        if (!expected.sendsTo) {
          expect(sqs).toEqual([]);
          return;
        }
        expect(sqs).toHaveLength(1);
        const actions = actionsOf(sqs[0] as Statement);
        expect(actions).toContain('sqs:SendMessage');
        expect(actions.filter((a) => /Receive|Delete|Purge/.test(a))).toEqual([]);
        expect(JSON.stringify(sqs[0]?.Resource)).toContain(`${expected.sendsTo}Queue`);
      },
    );

    it(
      expected.bucket
        ? `can use only ${expected.bucket.actions.join(', ')} on ${expected.bucket.pattern} in the bucket`
        : 'cannot touch the bucket',
      () => {
        const statements = statementsFor(template, routeKey).filter((s) =>
          actionsOf(s).some((a) => a.startsWith('s3:')),
        );
        if (!expected.bucket) {
          expect(statements).toEqual([]);
          return;
        }
        const wanted = [
          ...expected.bucket.actions,
          ...(expected.bucket.listBucket ? ['s3:ListBucket'] : []),
        ].sort();
        expect(statements.flatMap(actionsOf).sort()).toEqual(wanted);

        const objects = statements.find((s) =>
          actionsOf(s).includes(expected.bucket!.actions[0] as string),
        );
        expect(JSON.stringify(objects?.Resource)).toContain(`/${expected.bucket.pattern}"`);
        // The resource is the bucket's ARN plus exactly this key pattern: nothing else in the bucket.
        const parts = (objects?.Resource as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1];
        expect(parts.at(-1)).toBe(`/${expected.bucket.pattern}`);
        const list = statements.find((s) => actionsOf(s).includes('s3:ListBucket'));
        if (expected.bucket.listBucket) expect(JSON.stringify(list?.Resource)).not.toContain('/*');
        else expect(list).toBeUndefined();
      },
    );

    it(
      expected.invokesTestGeneration
        ? 'can invoke only the test-generation Lambda'
        : 'cannot invoke any Lambda',
      () => {
        const statements = statementsFor(template, routeKey).filter((s) =>
          actionsOf(s).some((a) => a.startsWith('lambda:')),
        );
        if (!expected.invokesTestGeneration) {
          expect(statements).toEqual([]);
          return;
        }
        expect(statements).toHaveLength(1);
        expect(actionsOf(statements[0] as Statement)).toEqual(['lambda:InvokeFunction']);
        const resources = JSON.stringify(statements[0]?.Resource);
        expect(resources).toContain('TestGenerationFunction');
        // The function's own ARN and its versions; never a wildcard over all functions.
        expect(resources).not.toMatch(/"\*"/);
      },
    );

    it(`${expected.collegeDomain ? 'gets' : 'does not get'} COLLEGE_DOMAIN`, () => {
      const vars = lambdaFor(template, routeKey).properties.Environment?.Variables ?? {};
      if (expected.collegeDomain) expect(vars['COLLEGE_DOMAIN']).toBe('college.edu');
      else expect(vars).not.toHaveProperty('COLLEGE_DOMAIN');
    });

    it('gets env vars only for what it is allowed to use', () => {
      const vars = Object.keys(
        lambdaFor(template, routeKey).properties.Environment?.Variables ?? {},
      );
      const wantedTables = Object.keys(expected.tables)
        .map(
          (t) =>
            ({
              Users: 'USERS_TABLE',
              Batches: 'BATCHES_TABLE',
              Questions: 'QUESTIONS_TABLE',
              Exams: 'EXAMS_TABLE',
              ExamStudents: 'EXAM_STUDENTS_TABLE',
              Answers: 'ANSWERS_TABLE',
              Appeals: 'APPEALS_TABLE',
              AuditLog: 'AUDIT_LOG_TABLE',
            })[t as 'Users'],
        )
        .sort();
      // The audit log table is on every route (see above).
      expect(vars.filter((v) => v.endsWith('_TABLE')).sort()).toEqual(
        [...new Set([...wantedTables, 'AUDIT_LOG_TABLE'])].sort(),
      );
      expect(vars.includes('BUCKET_NAME')).toBe(Boolean(expected.bucket));
      expect(vars.includes('TESTGEN_FUNCTION_NAME')).toBe(Boolean(expected.invokesTestGeneration));
      expect(vars.filter((v) => v.endsWith('_QUEUE_URL'))).toEqual(
        expected.sendsTo ? ['TRANSCRIBE_QUEUE_URL'] : [],
      );
    });
  });
});

describe('no route can delete', () => {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));

  it('has no DynamoDB delete or batch-write action in any route policy', () => {
    const actions = policies.flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as Statement[]).flatMap(actionsOf),
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((a) => /dynamodb:(Delete|BatchWrite|TransactWrite)/.test(a))).toEqual([]);
  });

  it('has no S3 delete action and no bucket-wide object grant in any route policy', () => {
    const statements = policies.flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Statement[],
    );
    expect(
      statements.flatMap(actionsOf).filter((a) => /^s3:(Delete|PutBucket|\*)/.test(a)),
    ).toEqual([]);
    // Reading and writing objects is always limited to one folder of the bucket. Only listing
    // (so a missing file is "not found") is on the bucket itself.
    for (const s of statements.filter((st) =>
      actionsOf(st).some((a) => /^s3:(Get|Put)Object/.test(a)),
    )) {
      expect(JSON.stringify(s.Resource)).toMatch(/\/(answers|questions|exams)\/\*/);
    }
    for (const s of statements.filter((st) => actionsOf(st).includes('s3:ListBucket'))) {
      expect(actionsOf(s)).toEqual(['s3:ListBucket']);
    }
  });

  it('never gives a route a wildcard resource', () => {
    for (const p of policies) {
      for (const s of p.Properties.PolicyDocument.Statement as Statement[]) {
        expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      }
    }
  });
});
