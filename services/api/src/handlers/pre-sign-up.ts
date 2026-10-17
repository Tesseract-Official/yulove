import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PreSignUpTriggerHandler } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

/** SUPER_ADMIN_EMAILS: comma-separated founder addresses; missing or empty means none. */
function superAdminEmails(): Set<string> {
  return new Set(
    (process.env['SUPER_ADMIN_EMAILS'] ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ''),
  );
}

/**
 * Whether this address may even try to sign up: it ends in @<college domain>, or it is exactly
 * one of the founders' addresses. Being in the Users table is checked separately.
 */
export function mayAttemptSignUp(
  email: string | undefined,
  collegeDomain: string,
  founders: ReadonlySet<string>,
): email is string {
  return Boolean(email) && (email!.endsWith(`@${collegeDomain}`) || founders.has(email!));
}

/**
 * Cognito pre-sign-up trigger. Throwing rejects the sign-up, so every failure
 * path (wrong domain, unknown user, lookup error) fails closed.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const collegeDomain = requireEnv('COLLEGE_DOMAIN').toLowerCase();
  const usersTable = requireEnv('USERS_TABLE');

  const email = event.request.userAttributes['email']?.trim().toLowerCase();
  if (!mayAttemptSignUp(email, collegeDomain, superAdminEmails())) {
    throw new Error('Sign-up is limited to college email addresses.');
  }

  const result = await ddb.send(new GetCommand({ TableName: usersTable, Key: { email } }));
  if (!result.Item) {
    throw new Error('This email has not been registered. Ask your batch manager.');
  }

  return event;
};
