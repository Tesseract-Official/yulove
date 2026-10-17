import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWebConfig, type WebConfig } from './web-env.js';

/**
 * The variables web/scripts/write-dist-config.ts reads in the Vercel build, and the config key each
 * one sets. (web/ has its own copy; each side's test pins the names.)
 */
export const VERCEL_VARS = {
  DSA_API_URL: 'apiUrl',
  DSA_COGNITO_DOMAIN: 'cognitoDomain',
  DSA_CLIENT_ID: 'clientId',
} as const satisfies Record<string, keyof WebConfig>;

/** One NAME=value line per variable, in the form Vercel's environment variable form accepts. */
export function formatVercelEnv(config: WebConfig): string {
  return Object.entries(VERCEL_VARS)
    .map(([name, key]) => `${name}=${config[key]}`)
    .join('\n');
}

/**
 * Prints the three values to paste into Vercel (Project Settings → Environment Variables), from the
 * deployed Auth and API stacks. They are public identifiers, not secrets.
 * Needs AWS_PROFILE, so the default credentials are never used by accident.
 */
async function main(): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(
      'Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm web:vercel-env',
    );
  }

  const config = await readWebConfig();
  console.log(
    `Profile ${profile}. Add these in Vercel (Project Settings → Environment Variables):\n`,
  );
  console.log(formatVercelEnv(config));
  console.log(
    '\nThen add your Vercel site origin (https://<project>.vercel.app) to "webOrigin" in ' +
      'infra/cdk.json, next to http://localhost:5173, and redeploy the Data, Auth and Api stacks.',
  );
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
