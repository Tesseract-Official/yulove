import type { Node } from 'constructs';

export const REGION = 'ap-south-1';

export interface AppConfig {
  /** College email domain without the leading @, lower case. */
  collegeDomain: string;
  /** Browser origins allowed to call the API and the bucket, no trailing slash. */
  webOrigins: string[];
  /** Gemini model that generates a question's tests (GEMINI_MODEL of the test-generation Lambda). */
  geminiTestgenModel: string;
  /** Gemini model that transcribes answer photos (used by the transcribe Lambda, built later). */
  geminiTranscribeModel: string;
  /** Who is emailed when spending reaches 80% and 100% of the monthly budget. */
  budgetEmail: string;
  /** Founders who may sign in as SUPER_ADMIN with a non-college address; lower case, no duplicates. */
  superAdminEmails: string[];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredContext(node: Node, key: string): string {
  const value: unknown = node.tryGetContext(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Missing CDK context "${key}". Pass it with: cdk synth -c ${key}=<value> (see docs/DESIGN.md).`,
    );
  }
  return value.trim();
}

/**
 * A JSON list in cdk.json, or a comma-separated string from `-c superAdminEmails=a@x.com,b@y.com`.
 */
function superAdminEmails(node: Node): string[] {
  const raw: unknown = node.tryGetContext('superAdminEmails');
  const items: unknown[] =
    typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? (raw as unknown[]) : [];
  const emails = [
    ...new Set(
      items.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : String(item))),
    ),
  ].filter((email) => email !== '');

  if (emails.length === 0) {
    throw new Error(
      'Missing CDK context "superAdminEmails": a list of founder email addresses (see infra/cdk.json).',
    );
  }
  for (const email of emails) {
    if (!EMAIL_SHAPE.test(email)) {
      throw new Error(`superAdminEmails must contain email addresses, got "${email}".`);
    }
  }
  return emails;
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

  const geminiTestgenModel = requiredContext(node, 'geminiTestgenModel');
  const geminiTranscribeModel = requiredContext(node, 'geminiTranscribeModel');

  // A <PLACEHOLDER> is allowed so the app can be synthesised before the real address is known,
  // but anything else must look like an email address.
  const budgetEmail = requiredContext(node, 'budgetEmail');
  if (!/^<.+>$/.test(budgetEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(budgetEmail)) {
    throw new Error(`budgetEmail must be an email address, got "${budgetEmail}".`);
  }

  return {
    collegeDomain,
    webOrigins,
    geminiTestgenModel,
    geminiTranscribeModel,
    budgetEmail,
    superAdminEmails: superAdminEmails(node),
  };
}
