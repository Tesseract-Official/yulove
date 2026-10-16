import type { Node } from 'constructs';

export const REGION = 'ap-south-1';

export interface AppConfig {
  /** College email domain without the leading @, lower case. */
  collegeDomain: string;
  /** Browser origins allowed to call the API and the bucket, no trailing slash. */
  webOrigins: string[];
  /** Gemini model used for test generation, e.g. a Pro-tier model with structured output. */
  geminiModel: string;
}

function requiredContext(node: Node, key: string): string {
  const value: unknown = node.tryGetContext(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Missing CDK context "${key}". Pass it with: cdk synth -c ${key}=<value> (see docs/DESIGN.md).`,
    );
  }
  return value.trim();
}

export function readConfig(node: Node): AppConfig {
  const collegeDomain = requiredContext(node, 'collegeDomain').replace(/^@/, '').toLowerCase();

  // A comma-separated list lets a localhost origin sit next to the real one.
  const webOrigins = requiredContext(node, 'webOrigin')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');
  for (const origin of webOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new Error(`webOrigin must be an origin like https://app.example.edu, got "${origin}".`);
    }
  }
  if (webOrigins.length === 0) {
    throw new Error('webOrigin must contain at least one origin.');
  }

  const geminiModel = requiredContext(node, 'geminiModel');

  return { collegeDomain, webOrigins, geminiModel };
}
