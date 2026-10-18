import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { mockClient } from 'aws-sdk-client-mock';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOG_GROUP_PREFIX, needsShorterRetention, setLogRetention } from './set-log-retention.js';

const logs = mockClient(CloudWatchLogsClient);
const client = new CloudWatchLogsClient({ region: 'ap-south-1' });

beforeEach(() => logs.reset());

describe('needsShorterRetention', () => {
  it.each([
    [undefined, true],
    [90, true],
    [31, true],
    [30, false],
    [7, false],
  ])('retention %s -> %s', (retentionInDays, expected) => {
    expect(needsShorterRetention({ retentionInDays })).toBe(expected);
  });
});

describe('setLogRetention', () => {
  it('sets 30 days on groups that never expire or keep longer, and skips the rest, across pages', async () => {
    logs
      .on(DescribeLogGroupsCommand)
      .resolvesOnce({
        logGroups: [
          { logGroupName: '/aws/lambda/DsaJudgeApi-a' },
          { logGroupName: '/aws/lambda/DsaJudgeApi-b', retentionInDays: 30 },
        ],
        nextToken: 'more',
      })
      .resolvesOnce({
        logGroups: [{ logGroupName: '/aws/lambda/DsaJudgePipeline-c', retentionInDays: 90 }],
      });
    logs.on(PutRetentionPolicyCommand).resolves({});

    const outcome = await setLogRetention(client);

    expect(outcome).toEqual({
      changed: ['/aws/lambda/DsaJudgeApi-a', '/aws/lambda/DsaJudgePipeline-c'],
      alreadyShort: ['/aws/lambda/DsaJudgeApi-b'],
    });
    expect(logs.commandCalls(PutRetentionPolicyCommand).map((c) => c.args[0].input)).toEqual([
      { logGroupName: '/aws/lambda/DsaJudgeApi-a', retentionInDays: 30 },
      { logGroupName: '/aws/lambda/DsaJudgePipeline-c', retentionInDays: 30 },
    ]);
    const first = logs.commandCalls(DescribeLogGroupsCommand)[0]?.args[0].input;
    expect(first?.logGroupNamePrefix).toBe(LOG_GROUP_PREFIX);
    expect(logs.commandCalls(DescribeLogGroupsCommand)[1]?.args[0].input.nextToken).toBe('more');
  });

  it('changes nothing in a dry run, and never deletes a log group', async () => {
    logs.on(DescribeLogGroupsCommand).resolves({
      logGroups: [{ logGroupName: '/aws/lambda/DsaJudgeApi-a' }],
    });

    const outcome = await setLogRetention(client, { dryRun: true });

    expect(outcome.changed).toEqual(['/aws/lambda/DsaJudgeApi-a']);
    expect(logs.commandCalls(PutRetentionPolicyCommand)).toHaveLength(0);
    expect(logs.calls().map((c) => c.args[0].constructor.name)).toEqual([
      'DescribeLogGroupsCommand',
    ]);
  });
});

describe('the command', () => {
  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'set-log-retention.ts'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
