import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ForbiddenError, NotFoundError, type AuditLogItem } from '@yulove/shared';
import { requireUser } from '@yulove/shared/server';
import { FakeDb } from '@yulove/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler as createBatch } from '../handlers/create-batch.js';
import { handler as createStaff } from '../handlers/create-staff.js';
import { apiHandler } from './http.js';

const db = new FakeDb();
const audits = () => db.all<AuditLogItem>('AuditLog');

const FOUNDER = 'founder@gmail.com';

beforeEach(() => {
  db.reset();
  process.env['AUDIT_LOG_TABLE'] = 'AuditLog';
  process.env['COLLEGE_DOMAIN'] = 'college.edu';
  db.addUser(userOf('SUPER_ADMIN', { email: FOUNDER }));
  db.addUser(userOf('TEACHER', { batchIds: ['A'] }));
  db.addUser(userOf('STUDENT', { batchId: 'A' }));
});

describe('apiHandler audits super admin requests', () => {
  it('writes an entry for a change made through a real route, with the new id', async () => {
    const { status } = await invoke(
      createBatch,
      makeEvent({
        method: 'POST',
        path: '/batches',
        email: FOUNDER,
        body: { batchId: '2026-A', name: 'CSE A' },
        requestId: 'req-batch',
      }),
    );

    expect(status).toBe(201);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      entityKey: 'request#req-batch',
      actor: FOUNDER,
      action: 'POST /batches',
      method: 'POST',
      path: '/batches',
      targetIds: { batchId: '2026-A' },
      statusCode: 201,
      outcome: 'success',
    });
    expect(Date.parse(audits()[0]?.timestamp ?? '')).not.toBeNaN();
  });

  it('writes an entry for a refused or invalid attempt too', async () => {
    const { status } = await invoke(
      createBatch,
      makeEvent({ method: 'POST', path: '/batches', email: FOUNDER, body: { name: 'no id' } }),
    );

    expect(status).toBe(422);
    expect(audits()[0]).toMatchObject({ statusCode: 422, outcome: 'rejected' });
  });

  it('records the created staff member as a target', async () => {
    await invoke(
      createStaff,
      makeEvent({
        method: 'POST',
        path: '/staff',
        email: FOUNDER,
        body: { email: 'new@college.edu', name: 'New Teacher', role: 'TEACHER' },
      }),
    );

    expect(audits()[0]).toMatchObject({
      action: 'POST /staff',
      targetIds: { email: 'new@college.edu' },
    });
  });

  it.each(['TEACHER', 'STUDENT'] as const)('does not write one for a %s', async (role) => {
    const { status } = await invoke(
      createBatch,
      makeEvent({
        method: 'POST',
        path: '/batches',
        email: userOf(role).email,
        body: { batchId: 'X', name: 'X' },
      }),
    );

    expect(status).toBe(403);
    expect(audits()).toEqual([]);
  });

  it('audits a route that never calls requireUser, so no route can skip it', async () => {
    const careless = apiHandler(() => Promise.resolve({ status: 200, body: { done: true } }));

    const { status, body } = await invoke(
      careless,
      makeEvent({
        method: 'DELETE',
        path: '/things/7',
        email: FOUNDER,
        pathParameters: { id: '7' },
      }),
    );

    expect(status).toBe(200);
    expect(body).toEqual({ done: true });
    expect(audits()[0]).toMatchObject({
      method: 'DELETE',
      targetIds: { id: '7' },
      outcome: 'success',
    });
  });

  it('audits when the route throws something unexpected, as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = apiHandler(() => Promise.reject(new Error('boom')));

    const { status } = await invoke(
      broken,
      makeEvent({ method: 'PUT', path: '/things/7', email: FOUNDER }),
    );
    error.mockRestore();

    expect(status).toBe(500);
    expect(audits()[0]).toMatchObject({ statusCode: 500, outcome: 'error' });
  });

  it.each([
    [new ForbiddenError(), 403, 'denied'],
    [new NotFoundError(), 404, 'rejected'],
  ] as const)('maps %s to outcome %s', async (thrown, statusCode, outcome) => {
    const route = apiHandler(() => Promise.reject(thrown));
    await invoke(route, makeEvent({ method: 'POST', path: '/x', email: FOUNDER }));
    expect(audits()[0]).toMatchObject({ statusCode, outcome });
  });

  it('reads the caller once when the route used requireUser', async () => {
    const route = apiHandler(async (event) => {
      await requireUser(event, ['TEACHER']);
      return { status: 200, body: {} };
    });
    await invoke(route, makeEvent({ method: 'POST', path: '/x', email: FOUNDER }));

    const reads = db.commandCalls(GetCommand);
    expect(reads).toHaveLength(1);
    expect(audits()).toHaveLength(1);
  });

  it('audits an inactive super admin the route refused', async () => {
    db.addUser(userOf('SUPER_ADMIN', { email: 'gone@gmail.com', active: false }));
    const route = apiHandler(async (event) => {
      await requireUser(event, []);
      return { status: 200, body: {} };
    });

    const { status } = await invoke(
      route,
      makeEvent({ method: 'POST', path: '/x', email: 'gone@gmail.com' }),
    );

    expect(status).toBe(403);
    expect(audits()[0]).toMatchObject({ actor: 'gone@gmail.com', outcome: 'denied' });
  });

  it('logs super admin reads of results and answers, not other reads', async () => {
    const read = apiHandler(() => Promise.resolve({ status: 200, body: { rows: [] } }));
    const get = (routeKey: string, path: string) =>
      invoke(read, makeEvent({ method: 'GET', path, routeKey, email: FOUNDER }));

    await get('GET /exams/{id}/results', '/exams/e1/results');
    await get('GET /answers/{examId}/{studentEmail}/{q}', '/answers/e1/s@college.edu/1');
    await get('GET /me', '/me');
    await get('GET /exams/{examId}/answers', '/exams/e1/answers');

    expect(
      audits()
        .map((a) => a.action)
        .sort(),
    ).toEqual(['GET /answers/{examId}/{studentEmail}/{q}', 'GET /exams/{id}/results']);
  });

  describe('when the audit table cannot be written', () => {
    let error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => error.mockRestore());

    it('still returns the real response and logs the entry', async () => {
      delete process.env['AUDIT_LOG_TABLE'];

      const { status, body } = await invoke(
        createBatch,
        makeEvent({
          method: 'POST',
          path: '/batches',
          email: FOUNDER,
          body: { batchId: 'B1', name: 'B' },
        }),
      );

      expect(status).toBe(201);
      expect(body.batch).toEqual({ batchId: 'B1', name: 'B' });
      expect(db.batches.has('B1')).toBe(true);
      expect(error.mock.calls.some((c: unknown[]) => c[0] === 'AUDIT WRITE FAILED')).toBe(true);
    });
  });
});

describe('every API handler goes through apiHandler', () => {
  const dir = fileURLToPath(new URL('../handlers/', import.meta.url));
  const handlers = readdirSync(dir).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'pre-sign-up.ts',
  );

  it('finds the handler files', () => {
    expect(handlers.length).toBeGreaterThan(10);
  });

  it.each(handlers)('%s exports handler = apiHandler(...)', (file) => {
    const source = readFileSync(`${dir}${file}`, 'utf8');
    expect(source).toMatch(/export const handler = apiHandler\(/);
    expect(source).not.toMatch(/export (async )?function handler\b/);
  });
});
