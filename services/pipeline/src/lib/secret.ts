import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

let cached: Promise<string> | undefined;

/**
 * The Gemini API key (the secret's plain-text value). Fetched once per Lambda container and
 * cached; a failed fetch is not cached, so the next invocation tries again.
 */
export function getGeminiApiKey(secretId = requireEnv('GEMINI_SECRET_NAME')): Promise<string> {
  cached ??= fetchKey(secretId).catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

/** For tests. */
export function resetGeminiApiKeyCache(): void {
  cached = undefined;
}

async function fetchKey(secretId: string): Promise<string> {
  const out = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const key = out.SecretString?.trim();
  if (!key) throw new Error('The Gemini API key secret is empty');
  return key;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
