import {
  ECRClient,
  GetLifecyclePolicyCommand,
  LifecyclePolicyNotFoundException,
  PutLifecyclePolicyCommand,
} from '@aws-sdk/client-ecr';
import { mockClient } from 'aws-sdk-client-mock';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyLifecycle,
  bootstrapRepositories,
  KEEP_IMAGES,
  lifecyclePolicy,
} from './ecr-lifecycle.js';

const ecr = mockClient(ECRClient);
const client = new ECRClient({ region: 'ap-south-1' });

beforeEach(() => ecr.reset());

describe('lifecyclePolicy', () => {
  it('expires every image beyond the newest three, tagged or not', () => {
    expect(KEEP_IMAGES).toBe(3);
    expect(lifecyclePolicy()).toEqual({
      rules: [
        {
          rulePriority: 1,
          description: 'Keep only the last 3 images',
          selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 3 },
          action: { type: 'expire' },
        },
      ],
    });
  });

  it.each([0, -1, 1.5])('refuses to keep %s images', (keep) => {
    expect(() => lifecyclePolicy(keep)).toThrow(/at least one/);
  });
});

describe('bootstrapRepositories', () => {
  it('finds only the CDK asset repository of the region', () => {
    expect(
      bootstrapRepositories([
        'cdk-hnb659fds-container-assets-123456789012-ap-south-1',
        'cdk-hnb659fds-container-assets-123456789012-us-east-1',
        'my-own-repo',
        'cdk-hnb659fds-container-assets-ap-south-1',
      ]),
    ).toEqual(['cdk-hnb659fds-container-assets-123456789012-ap-south-1']);
  });
});

describe('applyLifecycle', () => {
  it('puts the policy on the repository and reports the one it replaced', async () => {
    ecr.on(GetLifecyclePolicyCommand).resolves({ lifecyclePolicyText: '{"rules":[]}' });
    ecr.on(PutLifecyclePolicyCommand).resolves({});

    const outcome = await applyLifecycle(client, 'repo');

    expect(outcome).toMatchObject({ repository: 'repo', before: '{"rules":[]}', applied: true });
    expect(ecr.commandCalls(PutLifecyclePolicyCommand)[0]?.args[0].input).toEqual({
      repositoryName: 'repo',
      lifecyclePolicyText: JSON.stringify(lifecyclePolicy()),
    });
  });

  it('copes with a repository that has no policy yet', async () => {
    ecr
      .on(GetLifecyclePolicyCommand)
      .rejects(new LifecyclePolicyNotFoundException({ message: 'none', $metadata: {} }));
    ecr.on(PutLifecyclePolicyCommand).resolves({});

    await expect(applyLifecycle(client, 'repo')).resolves.toMatchObject({ before: undefined });
  });

  it('changes nothing in a dry run', async () => {
    ecr.on(GetLifecyclePolicyCommand).resolves({ lifecyclePolicyText: '{}' });

    const outcome = await applyLifecycle(client, 'repo', { dryRun: true });

    expect(outcome.applied).toBe(false);
    expect(ecr.commandCalls(PutLifecyclePolicyCommand)).toHaveLength(0);
  });
});

describe('the command', () => {
  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'ecr-lifecycle.ts'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
