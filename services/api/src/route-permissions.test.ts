import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ROUTES } from '@yulove/infra/routes';
import type { AuditHistoryResponse, TableName } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiEvent } from './lib/http.js';
import { handle as getAudit } from './handlers/get-answer-audit.js';
import { handler as setOverride } from './handlers/set-override.js';
import { handler as getAuditRoute } from './handlers/get-answer-audit.js';
import { invoke, makeEvent } from './test-utils/events.js';
import { EXAM_ID, examItem } from './test-utils/exams.js';
import { answerItem, seedGradingWorld, TEACHER_A } from './test-utils/answers.js';

/**
 * A Lambda only gets the table environment variables its route is granted in infra/src/routes.ts.
 * FakeDb normally sets all of them, which is how a handler that read a table its route did not
 * grant passed every test and failed in production. These tests run the handlers with only the
 * tables the real route table grants.
 */
const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const lambda = mockClient(LambdaClient);
const S1 = 's1@college.edu';
const SUPER = 'super-admin@college.edu';

/** Every handler module, loaded on demand (Vite's glob import; the project types do not include it). */
const handlerFiles = (
  import.meta as unknown as {
    glob: (patterns: string[]) => Record<string, () => Promise<unknown>>;
  }
).glob(['./handlers/*.ts', '!./handlers/*.test.ts']);

/** The tables a route's Lambda gets: the ones granted, and the audit log every route appends to. */
function grantedTables(handlerName: string): TableName[] {
  const route = ROUTES.find((r) => r.handler === handlerName);
  if (!route) throw new Error(`No route for ${handlerName}`);
  return [...(Object.keys(route.permissions.tables ?? {}) as TableName[]), 'AuditLog'];
}

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  lambda.reset();
  seedGradingWorld(db);
  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.put('Answers', answerItem(S1, 1));
});

const overrideEvent = (email: string, score: number | null, reason: string) =>
  makeEvent({
    method: 'PUT',
    path: `/answers/${EXAM_ID}/${S1}/1/override`,
    email,
    pathParameters: { examId: EXAM_ID, studentEmail: S1, q: '1' },
    body: { score, reason },
  });
const auditEvent = (email: string) =>
  makeEvent({
    method: 'GET',
    path: `/answers/${EXAM_ID}/${S1}/1/audit`,
    email,
    pathParameters: { examId: EXAM_ID, studentEmail: S1, q: '1' },
  });

describe('the score history, written and read under each route’s real permissions', () => {
  it.each([
    ['a teacher of the batch', TEACHER_A],
    ['a super admin', SUPER],
  ])(
    'shows %s the override that was just written through the set-override route',
    async (_who, email) => {
      // Write: only what PUT .../override is granted.
      db.restrictTablesTo(grantedTables('set-override'));
      const written = await invoke(setOverride, overrideEvent(TEACHER_A, 8, 'Misread'));
      expect(written.status).toBe(200);

      // Read: only what GET .../audit is granted.
      db.restrictTablesTo(grantedTables('get-answer-audit'));
      const { status, body } = await invoke(getAuditRoute, auditEvent(email));

      expect(status).toBe(200);
      const history = body as AuditHistoryResponse;
      expect(history.entries).toHaveLength(1);
      // The exact shape the web panel renders (AuditRow reads displayedScore from before/after).
      expect(history.entries[0]).toEqual({
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        actor: TEACHER_A,
        actorRole: 'TEACHER',
        action: 'OVERRIDE_SCORE',
        before: { override: null, displayedScore: 5 },
        after: { override: 8, displayedScore: 8 },
        reason: 'Misread',
      });
    },
  );

  it('would have caught the missing Exams grant: without it the reader cannot run at all', async () => {
    db.restrictTablesTo(['Users', 'Answers', 'AuditLog']); // what the route was granted before the fix
    await expect(getAudit(auditEvent(TEACHER_A))).rejects.toThrow(
      /Missing environment variable EXAMS_TABLE/,
    );
  });
});

describe('every route’s Lambda only reads the tables its route is granted', () => {
  // A super admin can get furthest into a handler, so they are the caller. 4xx answers are fine:
  // the failure looked for is a read of a table the route was never given.
  const world = (path: string) =>
    path
      .replace('{examId}', EXAM_ID)
      .replace('{id}', EXAM_ID)
      .replace('{studentEmail}', S1)
      .replace('{email}', S1)
      .replace('{batchId}', 'A')
      .replace('{q}', '1');

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))('%s', async (_name, route) => {
    s3.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 1000 });
    sqs.on(SendMessageCommand).resolves({});
    lambda.on(InvokeCommand).resolves({});
    Object.assign(process.env, {
      BUCKET_NAME: 'bucket',
      AWS_REGION: 'ap-south-1',
      AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
      AWS_SECRET_ACCESS_KEY: 'fake-secret',
      TRANSCRIBE_QUEUE_URL: 'https://sqs.example/transcribe.fifo',
      COLLEGE_DOMAIN: 'college.edu',
    });
    db.restrictTablesTo(grantedTables(route.handler));

    const load = handlerFiles[`./handlers/${route.handler}.ts`];
    if (!load) throw new Error(`No handler file for ${route.handler}`);
    const module = (await load()) as { handle: (event: ApiEvent) => Promise<unknown> };
    const pathParameters = Object.fromEntries(
      [...route.path.matchAll(/\{(\w+)\}/g)].map(([, key]) => [key as string, world(`{${key}}`)]),
    );
    const event = makeEvent({
      method: route.method,
      path: world(route.path),
      email: SUPER,
      pathParameters,
      query: { examId: EXAM_ID, batchId: 'A' },
      body: {},
    });

    try {
      await module.handle(event);
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/Missing environment variable/);
    }
  });
});
