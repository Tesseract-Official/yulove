import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Role } from '@yulove/shared';
import type { Context, PreSignUpTriggerEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from './pre-sign-up.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeEvent(
  email: string | undefined,
  extra: Record<string, string> = {},
): PreSignUpTriggerEvent {
  return {
    version: '1',
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_test',
    userName: 'Google_123',
    callerContext: { awsSdkVersion: 'test', clientId: 'client' },
    triggerSource: 'PreSignUp_ExternalProvider',
    request: { userAttributes: { ...(email === undefined ? {} : { email }), ...extra } },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

const run = (email: string | undefined, extra: Record<string, string> = {}) =>
  handler(makeEvent(email, extra), {} as Context, () => undefined);

/** The Users table holds this person. */
const registered = (role: Role, extra: { active?: boolean } = {}) =>
  ddbMock
    .on(GetCommand)
    .resolves({ Item: { email: 'x', role, name: 'X', active: true, ...extra } });

beforeEach(() => {
  ddbMock.reset();
  process.env['COLLEGE_DOMAIN'] = 'college.edu';
  process.env['USERS_TABLE'] = 'Users';
  // A founder list in the environment, as older deployments had, must change nothing.
  process.env['SUPER_ADMIN_EMAILS'] = 'founder@gmail.com';
});

describe('staff may sign in with any email domain', () => {
  it.each([
    ['teacher', 'TEACHER', 'tina@gmail.com'],
    ['teacher', 'TEACHER', 'tina@otheruniversity.ac.in'],
    ['teacher', 'TEACHER', 'tina@workspace-company.com'],
    ['teacher', 'TEACHER', 'tina@college.edu'],
    ['batch manager', 'BATCH_MANAGER', 'mo@gmail.com'],
    ['batch manager', 'BATCH_MANAGER', 'mo@otheruniversity.ac.in'],
    ['batch manager', 'BATCH_MANAGER', 'mo@college.edu'],
    ['super admin', 'SUPER_ADMIN', 'founder@gmail.com'],
    ['super admin', 'SUPER_ADMIN', 'founder@college.edu'],
    ['super admin', 'SUPER_ADMIN', 'someone-else@anywhere.org'],
  ] as const)('allows a registered, active %s (%s) on %s', async (_label, role, email) => {
    registered(role);

    const event = makeEvent(email);
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBe(event);
  });
});

describe('students keep the college-domain rule', () => {
  it('allows a registered student on the college domain', async () => {
    registered('STUDENT');
    await expect(run('student@college.edu')).resolves.toBeDefined();
  });

  it.each([
    ['a Gmail address', 'student@gmail.com'],
    ['another domain', 'student@otheruniversity.ac.in'],
    ['a sub-domain of the college', 'student@mail.college.edu'],
    ['a look-alike domain', 'student@college.edu.evil.com'],
    ['a domain that merely ends with the same text', 'student@notcollege.edu'],
  ])('refuses a registered student with %s', async (_label, email) => {
    registered('STUDENT');
    await expect(run(email)).rejects.toThrow(/Students must sign in with their college email/);
  });
});

describe('who is refused whatever the domain', () => {
  it.each([
    ['a teacher', 'TEACHER'],
    ['a batch manager', 'BATCH_MANAGER'],
    ['a super admin', 'SUPER_ADMIN'],
    ['a student', 'STUDENT'],
  ] as const)(
    'refuses a deactivated %s, on a Gmail and on the college address',
    async (_who, role) => {
      for (const email of ['person@gmail.com', 'person@college.edu']) {
        registered(role, { active: false });
        await expect(run(email)).rejects.toThrow(/made inactive/);
      }
    },
  );

  it.each([
    ['a Gmail address', 'stranger@gmail.com'],
    ['another domain', 'stranger@otheruniversity.ac.in'],
    ['the college domain', 'stranger@college.edu'],
    ['a listed founder address that has no Users row', 'founder@gmail.com'],
  ])('refuses an email that is not in the Users table: %s', async (_label, email) => {
    ddbMock.on(GetCommand).resolves({});
    await expect(run(email)).rejects.toThrow(/not been registered/);
  });

  it('refuses a record with a role it does not know', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'x', role: 'VISITOR', active: true } });
    await expect(run('x@gmail.com')).rejects.toThrow(/cannot sign in/);
  });

  it.each([
    ['a missing email', undefined],
    ['an empty email', ''],
    ['a blank email', '   '],
  ])('refuses %s without touching the Users table', async (_label, email) => {
    await expect(run(email)).rejects.toThrow(/did not give an email/);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('fails closed when the Users lookup fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('throttled'));
    await expect(run('tina@gmail.com')).rejects.toThrow('throttled');
  });

  it('fails closed when configuration is missing', async () => {
    delete process.env['COLLEGE_DOMAIN'];
    await expect(run('tina@gmail.com')).rejects.toThrow(/COLLEGE_DOMAIN/);
    process.env['COLLEGE_DOMAIN'] = 'college.edu';
    delete process.env['USERS_TABLE'];
    await expect(run('tina@gmail.com')).rejects.toThrow(/USERS_TABLE/);
  });
});

describe('the decision comes from the Users record', () => {
  it('looks the person up once, by the lower-case trimmed email', async () => {
    registered('TEACHER');

    await run('  Tina.Teacher@GMAIL.com ');

    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: 'Users',
      Key: { email: 'tina.teacher@gmail.com' },
    });
  });

  it('ignores anything else the sign-in says about the person', async () => {
    // The request claims a staff role and the college domain, but the record says student.
    registered('STUDENT');
    await expect(
      run('student@gmail.com', {
        'custom:role': 'SUPER_ADMIN',
        'custom:domain': 'college.edu',
        hd: 'college.edu',
        email_verified: 'true',
      }),
    ).rejects.toThrow(/Students must sign in/);

    // And the other way round: nothing in the request is needed for a teacher.
    registered('TEACHER');
    await expect(run('tina@gmail.com', { 'custom:role': 'STUDENT' })).resolves.toBeDefined();
  });

  it('follows a change of role: the same address is allowed or refused by its current record', async () => {
    registered('TEACHER');
    await expect(run('person@gmail.com')).resolves.toBeDefined();

    registered('STUDENT');
    await expect(run('person@gmail.com')).rejects.toThrow();

    registered('TEACHER');
    await expect(run('person@gmail.com')).resolves.toBeDefined();
  });
});
