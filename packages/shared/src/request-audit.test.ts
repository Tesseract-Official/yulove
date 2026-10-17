import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogDb } from './server.js';
import {
  auditSuperAdminRequest,
  isAuditedRequest,
  outcomeOf,
  requestAuditEntry,
  targetIdsOf,
  type AuditableEvent,
} from './request-audit.js';
import { FakeDb } from './testing/index.js';
import type { AuditLogItem, UserItem } from './types.js';

const db = new FakeDb();
const NOW = new Date('2026-10-17T10:00:00.000Z');
const now = () => NOW;

function eventFor(
  routeKey: string,
  {
    email,
    path = routeKey.split(' ')[1] as string,
    pathParameters,
    requestId = 'req-1',
  }: {
    email?: string;
    path?: string;
    pathParameters?: Record<string, string>;
    requestId?: string;
  } = {},
): AuditableEvent {
  return {
    routeKey,
    rawPath: path,
    pathParameters,
    requestContext: {
      requestId,
      authorizer: { jwt: { claims: email ? { email } : {} } },
    },
  };
}

const user = (role: UserItem['role'], email: string, extra: Partial<UserItem> = {}): UserItem => ({
  email,
  role,
  name: email,
  active: true,
  ...extra,
});

const audits = () => db.all<AuditLogItem>('AuditLog');

beforeEach(() => {
  db.reset();
  db.addUser(user('SUPER_ADMIN', 'founder@gmail.com'));
  db.addUser(user('TEACHER', 'teacher@college.edu', { batchIds: ['A'] }));
  db.addUser(user('BATCH_MANAGER', 'manager@college.edu', { batchIds: ['A'] }));
  db.addUser(user('STUDENT', 'student@college.edu', { batchId: 'A', rollNo: 'R1' }));
});

describe('isAuditedRequest', () => {
  it.each([
    'POST /exams',
    'PUT /exams/{id}',
    'PATCH /anything',
    'DELETE /anything/{id}',
    'POST /answers/upload-url',
    'PUT /answers/{examId}/{studentEmail}/{q}/override',
    'GET /exams/{id}/results',
    'GET /exams/exam-1/results',
    'GET /answers/{examId}/{studentEmail}/{q}',
  ])('logs %s', (routeKey) => {
    expect(isAuditedRequest(routeKey)).toBe(true);
  });

  it.each([
    'GET /me',
    'GET /batches/{batchId}/students',
    'GET /exams/{id}/pdf',
    'GET /exams/{examId}/answers',
    'GET /questions/{id}/tests',
    'GET /exams/{id}/results/extra',
    'GET /me/exams/{examId}',
  ])('does not log %s', (routeKey) => {
    expect(isAuditedRequest(routeKey)).toBe(false);
  });
});

describe('outcomeOf', () => {
  it.each([
    [200, 'success'],
    [201, 'success'],
    [401, 'denied'],
    [403, 'denied'],
    [404, 'rejected'],
    [409, 'rejected'],
    [422, 'rejected'],
    [500, 'error'],
    [502, 'error'],
  ] as const)('%s is %s', (status, outcome) => {
    expect(outcomeOf(status)).toBe(outcome);
  });
});

describe('targetIdsOf', () => {
  it('takes path parameters and the ids a response names, and path parameters win', () => {
    const ids = targetIdsOf(
      { pathParameters: { id: 'from-path', q: '2' } },
      JSON.stringify({ id: 'from-body', examId: 'exam-9', title: 'x', questionId: 7, batchId: '' }),
    );
    expect(ids).toEqual({ id: 'from-path', q: '2', examId: 'exam-9' });
  });

  it('finds ids inside the object a create route returns', () => {
    expect(
      targetIdsOf({}, JSON.stringify({ exam: { examId: 'e1', title: 'W1' }, rows: 3 })),
    ).toEqual({
      examId: 'e1',
    });
    expect(
      targetIdsOf({}, JSON.stringify({ user: { email: 'new@college.edu', role: 'TEACHER' } })),
    ).toEqual({ email: 'new@college.edu' });
    expect(
      targetIdsOf({}, JSON.stringify({ batch: { batchId: 'A' }, items: [{ examId: 'ignored' }] })),
    ).toEqual({ batchId: 'A' });
  });

  it('prefers the shallower id over a nested one', () => {
    expect(targetIdsOf({}, JSON.stringify({ examId: 'top', exam: { examId: 'nested' } }))).toEqual({
      examId: 'top',
    });
  });

  it('copes with no parameters, no body and a body that is not JSON', () => {
    expect(targetIdsOf({}, undefined)).toEqual({});
    expect(targetIdsOf({ pathParameters: { a: undefined } }, 'not json')).toEqual({});
    expect(targetIdsOf({}, '"text"')).toEqual({});
  });
});

describe('auditSuperAdminRequest', () => {
  it('writes the actor, method, path, target ids, time and outcome of a change', async () => {
    const event = eventFor('POST /exams/{id}/pdf', {
      email: 'Founder@Gmail.com',
      path: '/exams/exam-1/pdf',
      pathParameters: { id: 'exam-1' },
      requestId: 'abc',
    });

    await auditSuperAdminRequest(event, { statusCode: 200, body: '{"status":"READY"}' }, now);

    expect(audits()).toEqual([
      {
        entityKey: 'request#abc',
        timestamp: '2026-10-17T10:00:00.000Z',
        actor: 'founder@gmail.com',
        action: 'POST /exams/{id}/pdf',
        before: null,
        after: null,
        reason: '',
        method: 'POST',
        path: '/exams/exam-1/pdf',
        targetIds: { id: 'exam-1' },
        statusCode: 200,
        outcome: 'success',
      },
    ]);
  });

  it('records the id of something the request created', async () => {
    await auditSuperAdminRequest(
      eventFor('POST /exams', { email: 'founder@gmail.com' }),
      { statusCode: 201, body: JSON.stringify({ examId: 'new-exam', title: 'Week 1' }) },
      now,
    );

    expect(audits()[0]).toMatchObject({ targetIds: { examId: 'new-exam' }, outcome: 'success' });
  });

  it.each([
    ['PUT', 403, 'denied'],
    ['DELETE', 404, 'rejected'],
    ['POST', 422, 'rejected'],
    ['PATCH', 500, 'error'],
  ] as const)('logs a %s that ended with %s as %s', async (method, statusCode, outcome) => {
    await auditSuperAdminRequest(
      eventFor(`${method} /things/{id}`, { email: 'founder@gmail.com' }),
      { statusCode },
      now,
    );

    expect(audits()[0]).toMatchObject({ method, statusCode, outcome });
  });

  it('logs reads of results and answers', async () => {
    await auditSuperAdminRequest(
      eventFor('GET /exams/{id}/results', { email: 'founder@gmail.com', requestId: 'r1' }),
      { statusCode: 200, body: '{}' },
      now,
    );
    await auditSuperAdminRequest(
      eventFor('GET /answers/{examId}/{studentEmail}/{q}', {
        email: 'founder@gmail.com',
        requestId: 'r2',
        pathParameters: { examId: 'e', studentEmail: 's@college.edu', q: '1' },
      }),
      { statusCode: 200, body: '{}' },
      now,
    );

    expect(audits().map((a) => [a.action, a.method])).toEqual([
      ['GET /exams/{id}/results', 'GET'],
      ['GET /answers/{examId}/{studentEmail}/{q}', 'GET'],
    ]);
    expect(audits()[1]?.targetIds).toEqual({ examId: 'e', studentEmail: 's@college.edu', q: '1' });
  });

  it('does not log other reads by a super admin', async () => {
    await auditSuperAdminRequest(
      eventFor('GET /me', { email: 'founder@gmail.com' }),
      { statusCode: 200 },
      now,
    );
    expect(audits()).toEqual([]);
  });

  it.each([
    ['teacher@college.edu'],
    ['manager@college.edu'],
    ['student@college.edu'],
    ['stranger@college.edu'],
    [undefined],
  ])('does not log requests by %s', async (email) => {
    await auditSuperAdminRequest(eventFor('POST /exams', { email }), { statusCode: 201 }, now);
    await auditSuperAdminRequest(
      eventFor('GET /exams/{id}/results', { email }),
      { statusCode: 200 },
      now,
    );
    expect(audits()).toEqual([]);
  });

  it('never stores the request body or query string', async () => {
    const event = {
      ...eventFor('POST /batches/{batchId}/students/import', {
        email: 'founder@gmail.com',
        path: '/batches/A/students/import',
        pathParameters: { batchId: 'A' },
      }),
      body: '{"csv":"name,email\\nSecret Student,secret@college.edu"}',
      rawQueryString: 'token=secret',
    };

    await auditSuperAdminRequest(event, { statusCode: 200, body: '{"counts":{}}' }, now);

    expect(JSON.stringify(audits())).not.toMatch(/Secret|secret|token/);
  });

  it('keeps two requests in the same millisecond as two entries', async () => {
    const event = (requestId: string) =>
      eventFor('POST /exams', { email: 'founder@gmail.com', requestId });
    await auditSuperAdminRequest(event('a'), { statusCode: 201 }, now);
    await auditSuperAdminRequest(event('b'), { statusCode: 201 }, now);

    expect(audits()).toHaveLength(2);
    expect(new Set(audits().map((a) => a.entityKey))).toEqual(new Set(['request#a', 'request#b']));
  });

  it('can be found again by actor', async () => {
    await auditSuperAdminRequest(
      eventFor('POST /exams', { email: 'founder@gmail.com' }),
      { statusCode: 201 },
      now,
    );
    const found = await auditLogDb.listAuditByActor('founder@gmail.com');
    expect(found).toHaveLength(1);
  });

  describe('when the entry cannot be written', () => {
    let error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => error.mockRestore());

    it('does not throw, and logs the whole entry so the record is kept', async () => {
      delete process.env['AUDIT_LOG_TABLE'];

      await expect(
        auditSuperAdminRequest(
          eventFor('POST /exams', { email: 'founder@gmail.com', requestId: 'lost' }),
          { statusCode: 201, body: '{"examId":"e1"}' },
          now,
        ),
      ).resolves.toBeUndefined();

      expect(db.commandCalls(PutCommand)).toHaveLength(0);
      expect(error).toHaveBeenCalledTimes(1);
      const [message, json] = error.mock.calls[0] as [string, string];
      expect(message).toBe('AUDIT WRITE FAILED');
      expect(JSON.parse(json)).toMatchObject({
        routeKey: 'POST /exams',
        entry: {
          entityKey: 'request#lost',
          actor: 'founder@gmail.com',
          targetIds: { examId: 'e1' },
          outcome: 'success',
        },
      });
      process.env['AUDIT_LOG_TABLE'] = 'AuditLog';
    });
  });
});

describe('requestAuditEntry', () => {
  it('lower-cases the actor and carries no body', () => {
    const entry = requestAuditEntry(
      eventFor('DELETE /x/{id}', { pathParameters: { id: '1' } }),
      'Boss@Gmail.com',
      { statusCode: 200 },
      'r',
    );
    expect(entry.actor).toBe('boss@gmail.com');
    expect(entry.targetIds).toEqual({ id: '1' });
  });
});
