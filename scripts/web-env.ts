import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_STACK, requiredOutput, stackOutputs } from './smoke-worker.js';

export const REGION = 'ap-south-1';
export const API_STACK = 'DsaJudgeApi';

export const CONFIG_FILE = fileURLToPath(new URL('../web/public/config.json', import.meta.url));

/**
 * What the web app reads from /config.json at startup (web/src/config/config.ts). The redirect and
 * logout URLs are not in it: the app uses the origin it is served from, so http://localhost:5173
 * has to be in `webOrigin` in infra/cdk.json for local development.
 */
export interface WebConfig {
  apiUrl: string;
  cognitoDomain: string;
  clientId: string;
}

/** Builds the web app's config from the deployed Auth and API stack outputs. */
export function buildWebConfig(
  auth: Record<string, string>,
  api: Record<string, string>,
): WebConfig {
  return {
    apiUrl: requiredOutput(api, 'ApiUrl', API_STACK).replace(/\/+$/, ''),
    cognitoDomain: requiredOutput(auth, 'HostedUiBaseUrl', AUTH_STACK).replace(/\/+$/, ''),
    clientId: requiredOutput(auth, 'UserPoolClientId', AUTH_STACK),
  };
}

/** Reads the Auth and API stack outputs. The client reads AWS_PROFILE from the environment. */
export async function readWebConfig(): Promise<WebConfig> {
  const cfn = new CloudFormationClient({ region: REGION });
  const [auth, api] = await Promise.all([
    stackOutputs(cfn, AUTH_STACK),
    stackOutputs(cfn, API_STACK),
  ]);
  return buildWebConfig(auth, api);
}

export function writeWebConfig(config: WebConfig, file: string = CONFIG_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Writes web/public/config.json for local development from the deployed stacks' outputs.
 * Needs AWS_PROFILE, so the default credentials are never used by accident.
 */
async function main(): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error('Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm web:env');
  }

  const config = await readWebConfig();

  writeWebConfig(config);
  console.log(`Profile ${profile}. Wrote ${CONFIG_FILE}`);
  console.log(`  API         ${config.apiUrl}`);
  console.log(`  Cognito     ${config.cognitoDomain}`);
  console.log('Start the app with: pnpm --filter @yulove/web dev (http://localhost:5173)');
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
