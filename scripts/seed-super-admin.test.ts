import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeOutcome,
  normaliseEmail,
  seedSuperAdmin,
  seedSuperAdmins,
} from './seed-super-admin.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Founder@College.EDU ')).toBe('founder@college.edu');
  });

  it.each(['', 'nope', 'a@b', 'a b@c.d'])('rejects %j', (value) => {
    expect(() => normaliseEmail(value)).toThrow(/not a valid email/);
  });
});

describe('seedSuperAdmin', () => {
  beforeEach(() => ddbMock.reset());

  it('creates a SUPER_ADMIN user without overwriting anyone', async () => {
    ddbMock.on(PutCommand).resolves({});

    await expect(seedSuperAdmin(client, 'Users', 'Founder@College.edu', 'Founder')).resolves.toBe(
      'created',
    );

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toEqual({
      TableName: 'Users',
      Item: { email: 'founder@college.edu', role: 'SUPER_ADMIN', name: 'Founder', active: true },
      ConditionExpression: 'attribute_not_exists(email)',
    });
  });

  it('defaults the name to the email', async () => {
    ddbMock.on(PutCommand).resolves({});

    await seedSuperAdmin(client, 'Users', 'founder@college.edu');

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.['name']).toBe(
      'founder@college.edu',
    );
  });

  it('is a no-op when the user is already a super admin', async () => {
    ddbMock.on(PutCommand).rejects(conditionFailed());
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { email: 'founder@college.edu', role: 'SUPER_ADMIN' } });

    await expect(seedSuperAdmin(client, 'Users', 'founder@college.edu')).resolves.toBe(
      'already-seeded',
    );
  });

  it('refuses to change an existing user with another role', async () => {
    ddbMock.on(PutCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand).resolves({ Item: { email: 'teacher@college.edu', role: 'TEACHER' } });

    await expect(seedSuperAdmin(client, 'Users', 'teacher@college.edu')).rejects.toThrow(
      /already exists.*TEACHER/,
    );
  });

  it('passes other DynamoDB errors through', async () => {
    ddbMock.on(PutCommand).rejects(new Error('AccessDenied'));

    await expect(seedSuperAdmin(client, 'Users', 'founder@college.edu')).rejects.toThrow(
      'AccessDenied',
    );
  });

  it('rejects an invalid email before calling DynamoDB', async () => {
    await expect(seedSuperAdmin(client, 'Users', 'not-an-email')).rejects.toThrow();
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe('seedSuperAdmins', () => {
  beforeEach(() => ddbMock.reset());

  it('seeds every address, normalised, each with a conditional put', async () => {
    ddbMock.on(PutCommand).resolves({});

    const outcomes = await seedSuperAdmins(client, 'Users', [' One@Gmail.com', 'two@gmail.com']);

    expect(outcomes).toEqual([
      { email: 'one@gmail.com', status: 'created' },
      { email: 'two@gmail.com', status: 'created' },
    ]);
    const puts = ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input);
    expect(puts.map((p) => p.Item?.['email'])).toEqual(['one@gmail.com', 'two@gmail.com']);
    expect(puts.every((p) => p.Item?.['role'] === 'SUPER_ADMIN')).toBe(true);
    expect(puts.every((p) => p.ConditionExpression === 'attribute_not_exists(email)')).toBe(true);
  });

  it('keeps going after a failure, never overwrites, and reports each result', async () => {
    ddbMock
      .on(PutCommand)
      .resolvesOnce({})
      .rejectsOnce(conditionFailed())
      .rejectsOnce(conditionFailed());
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: { email: 'b@gmail.com', role: 'SUPER_ADMIN' } })
      .resolvesOnce({ Item: { email: 'c@gmail.com', role: 'STUDENT' } });

    const outcomes = await seedSuperAdmins(client, 'Users', [
      'a@gmail.com',
      'b@gmail.com',
      'c@gmail.com',
      'not-an-email',
    ]);

    expect(outcomes.map((o) => [o.email, o.status])).toEqual([
      ['a@gmail.com', 'created'],
      ['b@gmail.com', 'already-seeded'],
      ['c@gmail.com', 'failed'],
      ['not-an-email', 'failed'],
    ]);
    expect(outcomes[2]?.message).toMatch(/not overwriting/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(3);
  });

  it('describes each outcome on one line', () => {
    expect(describeOutcome({ email: 'a@x.com', status: 'created' }, 'Users')).toMatch(/Added a@x/);
    expect(describeOutcome({ email: 'a@x.com', status: 'already-seeded' }, 'Users')).toMatch(
      /nothing changed/,
    );
    expect(describeOutcome({ email: 'a@x.com', status: 'failed', message: 'boom' }, 'Users')).toBe(
      'FAILED a@x.com: boom',
    );
  });
});
