// Keeps only the last 3 worker images in ECR. The worker image is pushed by `cdk deploy` to the CDK
// bootstrap repository, which this app does not own, so the rule is put on it from here. That
// repository holds only the worker image (Lambdas are bundled to S3). Replaces the bootstrap's own
// rule, which only expires untagged images.
//
//   AWS_PROFILE=dsa-judge pnpm ecr:lifecycle --dry-run
//   AWS_PROFILE=dsa-judge pnpm ecr:lifecycle
import {
  DescribeRepositoriesCommand,
  ECRClient,
  GetLifecyclePolicyCommand,
  LifecyclePolicyNotFoundException,
  PutLifecyclePolicyCommand,
} from '@aws-sdk/client-ecr';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './args.js';
import { REGION } from './seed-super-admins.js';

/** Images kept; older ones (by push time) are expired. */
export const KEEP_IMAGES = 3;

/** The lifecycle policy: expire every image, tagged or not, beyond the newest `keep`. */
export function lifecyclePolicy(keep: number = KEEP_IMAGES) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Keep at least one image.');
  return {
    rules: [
      {
        rulePriority: 1,
        description: `Keep only the last ${keep} images`,
        selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: keep },
        action: { type: 'expire' },
      },
    ],
  };
}

/** The CDK bootstrap asset repositories among these names, e.g. cdk-hnb659fds-container-assets-123-ap-south-1. */
export function bootstrapRepositories(names: readonly string[], region: string = REGION): string[] {
  return names.filter((name) =>
    new RegExp(`^cdk-[a-z0-9]+-container-assets-\\d+-${region}$`).test(name),
  );
}

export interface LifecycleOutcome {
  repository: string;
  before: string | undefined;
  after: string;
  applied: boolean;
}

/** Puts the policy on the repository (or only reports what it would do in a dry run). */
export async function applyLifecycle(
  client: ECRClient,
  repository: string,
  options: { dryRun?: boolean; keep?: number } = {},
): Promise<LifecycleOutcome> {
  const after = JSON.stringify(lifecyclePolicy(options.keep));
  let before: string | undefined;
  try {
    before = (await client.send(new GetLifecyclePolicyCommand({ repositoryName: repository })))
      .lifecyclePolicyText;
  } catch (error) {
    if (!(error instanceof LifecyclePolicyNotFoundException)) throw error;
  }
  if (!options.dryRun) {
    await client.send(
      new PutLifecyclePolicyCommand({ repositoryName: repository, lifecyclePolicyText: after }),
    );
  }
  return { repository, before, after, applied: options.dryRun !== true };
}

async function main(argv: string[]): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(
      'Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm ecr:lifecycle --dry-run',
    );
  }
  const { values } = parseFlags(argv, { 'dry-run': { type: 'boolean' } });
  const dryRun = values['dry-run'] === true;

  const client = new ECRClient({ region: REGION });
  const all: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new DescribeRepositoriesCommand({ nextToken }));
    all.push(
      ...(page.repositories ?? []).flatMap((r) => (r.repositoryName ? [r.repositoryName] : [])),
    );
    nextToken = page.nextToken;
  } while (nextToken);

  const repositories = bootstrapRepositories(all);
  if (repositories.length !== 1) {
    throw new Error(
      `Expected one CDK asset repository in ${REGION}, found ${repositories.length}: ${repositories.join(', ') || 'none'}. Has the account been bootstrapped?`,
    );
  }

  const outcome = await applyLifecycle(client, repositories[0] as string, { dryRun });
  console.log(`Profile ${profile}, repository ${outcome.repository}${dryRun ? ' (dry run)' : ''}.`);
  console.log(`Current policy: ${outcome.before ?? 'none'}`);
  console.log(`${dryRun ? 'Would set' : 'Set'}: ${outcome.after}`);
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
