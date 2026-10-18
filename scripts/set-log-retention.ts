// Sets 30 days of retention on the app's Lambda log groups that Lambda made by itself before the
// stacks managed them, which never expire. It only changes retention; it deletes nothing, and
// leaves groups that already keep 30 days or less alone.
//
//   AWS_PROFILE=dsa-judge pnpm logs:retention -- --dry-run
//   AWS_PROFILE=dsa-judge pnpm logs:retention
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { REGION } from './seed-super-admins.js';

export const RETENTION_DAYS = 30;

/** Lambda names start with their stack's name, and every stack of the app starts with DsaJudge. */
export const LOG_GROUP_PREFIX = '/aws/lambda/DsaJudge';

export interface LogGroupSummary {
  retentionInDays?: number | undefined;
}

export interface RetentionOutcome {
  changed: string[];
  alreadyShort: string[];
}

/** The groups that keep logs longer than `days`, or forever. */
export function needsShorterRetention(
  group: LogGroupSummary,
  days: number = RETENTION_DAYS,
): boolean {
  return group.retentionInDays === undefined || group.retentionInDays > days;
}

export async function setLogRetention(
  client: CloudWatchLogsClient,
  options: { dryRun?: boolean; days?: number; log?: (line: string) => void } = {},
): Promise<RetentionOutcome> {
  const days = options.days ?? RETENTION_DAYS;
  const outcome: RetentionOutcome = { changed: [], alreadyShort: [] };

  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP_PREFIX, nextToken }),
    );
    for (const group of page.logGroups ?? []) {
      if (!group.logGroupName) continue;
      if (!needsShorterRetention(group, days)) {
        outcome.alreadyShort.push(group.logGroupName);
        continue;
      }
      if (!options.dryRun) {
        await client.send(
          new PutRetentionPolicyCommand({
            logGroupName: group.logGroupName,
            retentionInDays: days,
          }),
        );
      }
      outcome.changed.push(group.logGroupName);
      options.log?.(
        `${options.dryRun ? 'Would set' : 'Set'} ${days} days on ${group.logGroupName}`,
      );
    }
    nextToken = page.nextToken;
  } while (nextToken);

  return outcome;
}

async function main(argv: string[]): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(
      'Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm logs:retention -- --dry-run',
    );
  }
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' } } });
  const dryRun = values['dry-run'] === true;

  console.log(`Profile ${profile}${dryRun ? ' (dry run)' : ''}.`);
  const outcome = await setLogRetention(new CloudWatchLogsClient({ region: REGION }), {
    dryRun,
    log: console.log,
  });
  console.log(
    `${outcome.changed.length} log groups ${dryRun ? 'would change' : 'changed'}, ${outcome.alreadyShort.length} already keep ${RETENTION_DAYS} days or less.`,
  );
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
