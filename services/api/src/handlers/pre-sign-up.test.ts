import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Context, PreSignUpTriggerEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from './pre-sign-up.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeEvent(email: string | undefined): PreSignUpTriggerEvent {
  return {
    version: '1',
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_test',
    userName: 'Google_123',
    callerContext: { awsSdkVersion: 'test', clientId: 'client' },
    triggerSource: 'PreSignUp_ExternalProvider',
    request: { userAttributes: email === undefined ? {} : { email } },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

const run = (email: string | undefined) =>
  handler(makeEvent(email), {} as Context, () => undefined);

describe('pre-sign-up handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env['COLLEGE_DOMAIN'] = 'college.edu';
    process.env['USERS_TABLE'] = 'Users';
  });

  it('allows a registered user on the college domain', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'student@college.edu', role: 'STUDENT' } });

    const event = makeEvent('student@college.edu');
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBe(event);

    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: 'Users',
      Key: { email: 'student@college.edu' },
    });
  });

  it('normalises email case before the lookup', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'student@college.edu' } });

    await expect(run('Student@College.EDU')).resolves.toBeDefined();
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      email: 'student@college.edu',
    });
  });

  it.each([
    ['another domain', 'student@gmail.com'],
    ['a sub-domain of the college', 'student@mail.college.edu'],
    ['a look-alike domain', 'student@college.edu.evil.com'],
    ['a domain that merely ends with the same text', 'student@notcollege.edu'],
    ['a missing email', undefined],
    ['an empty email', ''],
  ])('rejects %s without touching the Users table', async (_label, email) => {
    await expect(run(email)).rejects.toThrow();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('rejects an email that is not in the Users table', async () => {
    ddbMock.on(GetCommand).resolves({});

    await expect(run('stranger@college.edu')).rejects.toThrow(/not been registered/);
  });

  it('rejects when the Users lookup fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('throttled'));

    await expect(run('student@college.edu')).rejects.toThrow('throttled');
  });

  it('fails closed when configuration is missing', async () => {
    delete process.env['COLLEGE_DOMAIN'];

    await expect(run('student@college.edu')).rejects.toThrow(/COLLEGE_DOMAIN/);
  });
});
