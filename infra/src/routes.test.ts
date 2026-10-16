import type { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ROUTES } from './routes.js';
import { buildApp } from './testing.js';

type Access = 'none' | 'read' | 'readWrite' | 'write';

interface Expected {
  routeKey: string;
  /** Access per table; any table not listed must be 'none'. */
  tables: Partial<Record<string, Access>>;
  collegeDomain?: boolean;
  /** The route may read this key pattern of the bucket, and nothing else in it. */
  bucketRead?: string;
  /** The route may invoke the test-generation Lambda, and no other function. */
  invokesTestGeneration?: boolean;
}

// Written by hand: what each route's Lambda may do. Every route reads Users (requireUser).
const EXPECTED: Expected[] = [
  { routeKey: 'GET /me', tables: { Users: 'read', Batches: 'read' } },
  { routeKey: 'POST /staff', tables: { Users: 'readWrite', Batches: 'read' }, collegeDomain: true },
  { routeKey: 'PUT /staff/{email}/batches', tables: { Users: 'readWrite', Batches: 'read' } },
  { routeKey: 'POST /batches', tables: { Users: 'read', Batches: 'write' } },
  {
    routeKey: 'POST /batches/{batchId}/students/import',
    tables: { Users: 'readWrite', Batches: 'read' },
    collegeDomain: true,
  },
  { routeKey: 'GET /batches/{batchId}/students', tables: { Users: 'read', Batches: 'read' } },
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
    bucketRead: 'questions/*',
  },
  { routeKey: 'POST /questions/{id}/approve', tables: { Users: 'read', Questions: 'readWrite' } },
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
        expect(accessTo(statements, `${table}Table`), table).toBe(expected.tables[table] ?? 'none');
      }
    });

    it('cannot touch queues or secrets', () => {
      const actions = statementsFor(template, routeKey).flatMap(actionsOf);
      expect(actions.filter((a) => /^(sqs|secretsmanager):/.test(a))).toEqual([]);
    });

    it(
      expected.bucketRead
        ? `can read only ${expected.bucketRead} in the bucket`
        : 'cannot touch the bucket',
      () => {
        const statements = statementsFor(template, routeKey).filter((s) =>
          actionsOf(s).some((a) => a.startsWith('s3:')),
        );
        if (!expected.bucketRead) {
          expect(statements).toEqual([]);
          return;
        }
        const actions = statements.flatMap(actionsOf).sort();
        // GetObject on the pattern; ListBucket so a missing file is "not found", not "denied".
        expect(actions).toEqual(['s3:GetObject', 's3:ListBucket']);
        const objects = statements.find((s) => actionsOf(s).includes('s3:GetObject'));
        expect(JSON.stringify(objects?.Resource)).toContain(`/${expected.bucketRead}`);
        const list = statements.find((s) => actionsOf(s).includes('s3:ListBucket'));
        expect(JSON.stringify(list?.Resource)).not.toContain('/*');
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
              Answers: 'ANSWERS_TABLE',
            })[t as 'Users'],
        )
        .sort();
      expect(vars.filter((v) => v.endsWith('_TABLE')).sort()).toEqual(wantedTables);
      expect(vars.includes('BUCKET_NAME')).toBe(Boolean(expected.bucketRead));
      expect(vars.includes('TESTGEN_FUNCTION_NAME')).toBe(Boolean(expected.invokesTestGeneration));
      expect(vars.filter((v) => v.endsWith('_QUEUE_URL'))).toEqual([]);
    });
  });
});
