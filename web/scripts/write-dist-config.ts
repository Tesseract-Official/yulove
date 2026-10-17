import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfigSchema, type AppConfig } from '../src/config/config.js';

/** The environment variables the Vercel build reads, and the config.json key each one sets. */
export const ENV_VARS = {
  DSA_API_URL: 'apiUrl',
  DSA_COGNITO_DOMAIN: 'cognitoDomain',
  DSA_CLIENT_ID: 'clientId',
} as const satisfies Record<string, keyof AppConfig>;

/** Builds config.json from the environment. Throws one error that names everything wrong. */
export function configFromEnv(env: Record<string, string | undefined>): AppConfig {
  const names = Object.keys(ENV_VARS) as Array<keyof typeof ENV_VARS>;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.\n` +
        'Set DSA_API_URL, DSA_COGNITO_DOMAIN and DSA_CLIENT_ID in Vercel (Project Settings → ' +
        'Environment Variables). `AWS_PROFILE=<profile> pnpm web:vercel-env` prints the values.',
    );
  }

  const result = appConfigSchema.safeParse(
    Object.fromEntries(names.map((name) => [ENV_VARS[name], env[name]?.trim()])),
  );
  if (!result.success) {
    const bad = result.error.issues.map((issue) => {
      const name = names.find((n) => ENV_VARS[n] === issue.path[0]);
      return `${name ?? issue.path.join('.')} (${issue.message})`;
    });
    throw new Error(`Invalid environment variable value: ${bad.join(', ')}.`);
  }
  return result.data;
}

export const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

/** Writes dist/config.json, the file the app loads at startup. Run after `vite build`. */
export function writeDistConfig(config: AppConfig, distDir: string = DIST_DIR): string {
  const file = join(distDir, 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  try {
    // DSA_DIST_DIR is only for tests; the build writes into dist/.
    const file = writeDistConfig(configFromEnv(process.env), process.env['DSA_DIST_DIR']);
    console.log(`Wrote ${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
