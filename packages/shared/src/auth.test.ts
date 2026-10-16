import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { canUserAccessBatch, requireUser, type AuthEvent } from './auth.js';
import { ROLES, type Role } from './enums.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';
import type { UserItem } from './types.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const eventFor = (email: unknown): AuthEvent => ({
  requestContext: { authorizer: { jwt: { claims: email === undefined ? {} : { email } } } },
});

function userWith(role: Role, extra: Partial<UserItem> = {}): UserItem {
  return { email: 'person@college.edu', role, name: 'Person', active: true, ...extra };
}

beforeEach(() => {
  ddbMock.reset();
  process.env['USERS_TABLE'] = 'Users';
});

function stubUser(user: UserItem | undefined) {
  ddbMock.on(GetCommand).resolves({ Item: user });
}

describe('canUserAccessBatch: every role and batch combination', () => {
  // [description, user, batch asked about, expected]
  const cases: [string, UserItem, string, boolean][] = [
    ['super admin, any batch', userWith('SUPER_ADMIN'), 'B1', true],
    [
      'super admin with a batch list, other batch',
      userWith('SUPER_ADMIN', { batchIds: ['B2'] }),
      'B1',
      true,
    ],
    ['teacher assigned to the batch', userWith('TEACHER', { batchIds: ['B1', 'B2'] }), 'B1', true],
    [
      'teacher assigned to other batches only',
      userWith('TEACHER', { batchIds: ['B2'] }),
      'B1',
      false,
    ],
    ['teacher with an empty list', userWith('TEACHER', { batchIds: [] }), 'B1', false],
    ['teacher with no list', userWith('TEACHER'), 'B1', false],
    [
      'batch manager assigned to the batch',
      userWith('BATCH_MANAGER', { batchIds: ['B1'] }),
      'B1',
      true,
    ],
    [
      'batch manager assigned to other batches',
      userWith('BATCH_MANAGER', { batchIds: ['B2', 'B3'] }),
      'B1',
      false,
    ],
    ['batch manager with an empty list', userWith('BATCH_MANAGER', { batchIds: [] }), 'B1', false],
    ['batch manager with no list', userWith('BATCH_MANAGER'), 'B1', false],
    ['student in the batch', userWith('STUDENT', { batchId: 'B1' }), 'B1', true],
    ['student in another batch', userWith('STUDENT', { batchId: 'B2' }), 'B1', false],
    ['student with no batch', userWith('STUDENT'), 'B1', false],
    [
      'student with a batchIds list is not a manager',
      userWith('STUDENT', { batchIds: ['B1'] }),
      'B1',
      false,
    ],
  ];

  it.each(cases)('%s', (_label, user, batchId, expected) => {
    expect(canUserAccessBatch(user, batchId)).toBe(expected);
  });
});

describe('requireUser: role checks', () => {
  const ALLOWED_SETS: [string, readonly Role[]][] = [
    ['no roles', []],
    ['teacher only', ['TEACHER']],
    ['batch manager only', ['BATCH_MANAGER']],
    ['student only', ['STUDENT']],
    ['teacher and batch manager', ['TEACHER', 'BATCH_MANAGER']],
    ['all roles', ROLES],
  ];

  describe.each(ROLES)('as %s', (role) => {
    it.each(ALLOWED_SETS)('allowed: %s', async (_label, allowed) => {
      stubUser(userWith(role));

      // SUPER_ADMIN passes every check; everyone else needs to be in the list.
      const shouldPass = role === 'SUPER_ADMIN' || allowed.includes(role);
      const result = requireUser(eventFor('person@college.edu'), allowed);

      if (shouldPass) {
        await expect(result).resolves.toMatchObject({ user: { role } });
      } else {
        await expect(result).rejects.toBeInstanceOf(ForbiddenError);
      }
    });
  });
});

describe('requireUser: batch access on the returned context', () => {
  it.each(cases())('%s', async (_label, user, batchId, expected) => {
    stubUser(user);
    const ctx = await requireUser(eventFor(user.email), ROLES);

    expect(ctx.canAccessBatch(batchId)).toBe(expected);
    if (expected) {
      expect(() => ctx.assertBatchAccess(batchId)).not.toThrow();
    } else {
      expect(() => ctx.assertBatchAccess(batchId)).toThrow(ForbiddenError);
    }
  });

  function cases(): [string, UserItem, string, boolean][] {
    return [
      ['super admin reaches any batch', userWith('SUPER_ADMIN'), 'B9', true],
      ['teacher reaches an assigned batch', userWith('TEACHER', { batchIds: ['B1'] }), 'B1', true],
      [
        'teacher is denied an unassigned batch',
        userWith('TEACHER', { batchIds: ['B1'] }),
        'B2',
        false,
      ],
      [
        'batch manager reaches an assigned batch',
        userWith('BATCH_MANAGER', { batchIds: ['B1'] }),
        'B1',
        true,
      ],
      [
        'batch manager is denied an unassigned batch',
        userWith('BATCH_MANAGER', { batchIds: ['B1'] }),
        'B2',
        false,
      ],
      ['student reaches own batch', userWith('STUDENT', { batchId: 'B1' }), 'B1', true],
      ['student is denied another batch', userWith('STUDENT', { batchId: 'B1' }), 'B2', false],
    ];
  }
});

describe('requireUser: identity', () => {
  it('rejects a deactivated user with 403, for every role', async () => {
    for (const role of ROLES) {
      stubUser(userWith(role, { active: false }));
      const error = await requireUser(eventFor('person@college.edu'), ROLES).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).statusCode).toBe(403);
    }
  });

  it('rejects a deactivated super admin too', async () => {
    stubUser(userWith('SUPER_ADMIN', { active: false }));
    await expect(requireUser(eventFor('person@college.edu'), [])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('rejects a user who is not in the Users table with 403', async () => {
    stubUser(undefined);
    const error = await requireUser(eventFor('stranger@college.edu'), ROLES).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ['no email claim', undefined],
    ['an empty email claim', '  '],
    ['a non-string email claim', 42],
  ])('rejects %s with 401 and never reads the table', async (_label, claim) => {
    const error = await requireUser(eventFor(claim), ROLES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as UnauthorizedError).statusCode).toBe(401);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('rejects a request with no authorizer context with 401', async () => {
    await expect(requireUser({ requestContext: {} }, ROLES)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('finds a user stored in lower case from a mixed-case JWT email', async () => {
    const stored = userWith('STUDENT', { email: 'student@college.edu', batchId: 'B1' });
    // Only an exact-key lookup of the lower-case email finds the user.
    ddbMock.on(GetCommand).callsFake((input: { Key: { email: string } }) => ({
      Item: input.Key.email === stored.email ? stored : undefined,
    }));

    const ctx = await requireUser(eventFor('Student@College.edu'), ['STUDENT']);

    expect(ctx.user.email).toBe('student@college.edu');
  });

  it('looks the user up by lower-cased email', async () => {
    stubUser(userWith('STUDENT', { batchId: 'B1' }));
    await requireUser(eventFor('  Person@College.EDU '), ROLES);

    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: 'Users',
      Key: { email: 'person@college.edu' },
    });
  });
});
