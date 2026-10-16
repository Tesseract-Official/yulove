import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { normaliseEmail, seedSuperAdmin } from './seed-super-admin.js';

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
