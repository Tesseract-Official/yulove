import { z } from 'zod';

const baseUrl = z.url().transform((value) => value.replace(/\/+$/, ''));

/**
 * What /config.json must contain. Written by `pnpm web:env` locally and by the Vercel build
 * (`build:vercel`). The redirect and logout URLs are not here: the app derives them from the origin
 * it is served from.
 */
export const appConfigSchema = z.object({
  apiUrl: baseUrl,
  /** The Cognito hosted UI domain, e.g. https://dsa-judge-123.auth.ap-south-1.amazoncognito.com */
  cognitoDomain: baseUrl,
  clientId: z.string().trim().min(1),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CONFIG_PATH = '/config.json';

/** Fetches and validates the runtime config. Throws ConfigError with a message a person can act on. */
export async function loadConfig(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  path: string = CONFIG_PATH,
): Promise<AppConfig> {
  let response: Response;
  try {
    response = await fetchFn(path, { cache: 'no-store' });
  } catch {
    throw new ConfigError(`Could not download ${path}. Check your connection and reload.`);
  }
  if (!response.ok) {
    throw new ConfigError(`Could not load ${path} (HTTP ${response.status}).`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // A dev server answers a missing file with index.html, which is not JSON.
    throw new ConfigError(`${path} is missing or is not valid JSON. Locally, run: pnpm web:env`);
  }

  const result = appConfigSchema.safeParse(json);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ConfigError(`${path} is invalid: check ${fields.join(', ')}.`);
  }
  return result.data;
}
