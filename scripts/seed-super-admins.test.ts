import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATA_STACK, readSuperAdminEmails, usersTableFromStack } from './seed-super-admins.js';

const cfnMock = mockClient(CloudFormationClient);
const client = new CloudFormationClient({ region: 'ap-south-1' });

function configFile(context: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cdk-')), 'cdk.json');
  writeFileSync(file, JSON.stringify({ context }));
  return file;
}

describe('readSuperAdminEmails', () => {
  it('reads the list from a cdk.json', () => {
    expect(readSuperAdminEmails(configFile({ superAdminEmails: ['a@gmail.com'] }))).toEqual([
      'a@gmail.com',
    ]);
  });

  it.each([
    {},
    { superAdminEmails: [] },
    { superAdminEmails: 'a@gmail.com' },
    { superAdminEmails: [1] },
  ])('throws for %j', (context) => {
    expect(() => readSuperAdminEmails(configFile(context))).toThrow(/superAdminEmails/);
  });

  it("reads the repository's own infra/cdk.json, which lists the two founders", () => {
    const real = fileURLToPath(new URL('../infra/cdk.json', import.meta.url));
    expect(readSuperAdminEmails(real)).toEqual([
      'meloovegupta@gmail.com',
      'ramoliyayug55@gmail.com',
    ]);
    expect(readFileSync(real, 'utf8')).toContain('"budgetEmail": "ramoliyayug55@gmail.com"');
  });
});

describe('usersTableFromStack', () => {
  beforeEach(() => cfnMock.reset());

  it('reads the Users table name from the data stack outputs', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: DATA_STACK,
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: new Date(),
          Outputs: [
            { OutputKey: 'BucketName', OutputValue: 'bucket' },
            { OutputKey: 'UsersTableName', OutputValue: 'DsaJudgeData-UsersTable-ABC' },
          ],
        },
      ],
    });

    await expect(usersTableFromStack(client)).resolves.toBe('DsaJudgeData-UsersTable-ABC');
    expect(cfnMock.commandCalls(DescribeStacksCommand)[0]?.args[0].input).toEqual({
      StackName: 'DsaJudgeData',
    });
  });

  it('explains when the output is missing', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: DATA_STACK,
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: new Date(),
          Outputs: [],
        },
      ],
    });

    await expect(usersTableFromStack(client)).rejects.toThrow(/no output UsersTableName/);
  });

  it('passes AWS errors through, such as a stack that does not exist', async () => {
    cfnMock.on(DescribeStacksCommand).rejects(new Error('Stack DsaJudgeData does not exist'));

    await expect(usersTableFromStack(client)).rejects.toThrow(/does not exist/);
  });
});
