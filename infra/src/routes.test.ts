import type { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ROUTES } from './routes.js';
import { buildApp } from './testing.js';

type Access = 'none' | 'read' | 'readWrite' | 'write';

interface Expected {
  routeKey: string;
  users: Access;
  batches: Access;
  collegeDomain: boolean;
}

// Written by hand: what each route's Lambda may do to each table.
const EXPECTED: Expected[] = [
  { routeKey: 'GET /me', users: 'read', batches: 'read', collegeDomain: false },
  { routeKey: 'POST /staff', users: 'readWrite', batches: 'read', collegeDomain: true },
  {
    routeKey: 'PUT /staff/{email}/batches',
    users: 'readWrite',
    batches: 'read',
    collegeDomain: false,
  },
  { routeKey: 'POST /batches', users: 'read', batches: 'write', collegeDomain: false },
  {
    routeKey: 'POST /batches/{batchId}/students/import',
    users: 'readWrite',
    batches: 'read',
    collegeDomain: true,
  },
  {
    routeKey: 'GET /batches/{batchId}/students',
    users: 'read',
    batches: 'read',
    collegeDomain: false,
  },
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
  it('are exactly the six first routes', () => {
    expect(ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      EXPECTED.map((e) => e.routeKey).sort(),
    );
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 6);
  });

  describe.each(EXPECTED)('$routeKey', ({ routeKey, users, batches, collegeDomain }) => {
    it('is protected by the JWT authorizer', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'JWT',
      });
    });

    it('runs on Node.js 22', () => {
      expect(lambdaFor(template, routeKey).properties.Runtime).toBe('nodejs22.x');
    });

    it(`has ${users} on Users and ${batches} on Batches, and no other table`, () => {
      const statements = statementsFor(template, routeKey);

      expect(accessTo(statements, 'UsersTable')).toBe(users);
      expect(accessTo(statements, 'BatchesTable')).toBe(batches);
      for (const other of [
        'Questions',
        'Exams',
        'ExamStudents',
        'Answers',
        'Appeals',
        'AuditLog',
      ]) {
        expect(accessTo(statements, `${other}Table`)).toBe('none');
      }
    });

    it('cannot touch queues, the bucket or secrets', () => {
      const actions = statementsFor(template, routeKey).flatMap(actionsOf);
      expect(actions.filter((a) => /^(sqs|s3|secretsmanager):/.test(a))).toEqual([]);
    });

    it(`${collegeDomain ? 'gets' : 'does not get'} COLLEGE_DOMAIN`, () => {
      const vars = lambdaFor(template, routeKey).properties.Environment?.Variables ?? {};
      if (collegeDomain) expect(vars['COLLEGE_DOMAIN']).toBe('college.edu');
      else expect(vars).not.toHaveProperty('COLLEGE_DOMAIN');
    });

    it('gets the table names it is allowed to use as env vars, and no others', () => {
      const vars = Object.keys(
        lambdaFor(template, routeKey).properties.Environment?.Variables ?? {},
      );
      expect(vars.filter((v) => v.endsWith('_TABLE')).sort()).toEqual([
        'BATCHES_TABLE',
        'USERS_TABLE',
      ]);
      expect(vars).not.toContain('BUCKET_NAME');
      expect(vars.filter((v) => v.endsWith('_QUEUE_URL'))).toEqual([]);
    });
  });
});
