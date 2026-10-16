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

/**
 * Cognito pre-sign-up trigger. Throwing rejects the sign-up, so every failure
 * path (wrong domain, unknown user, lookup error) fails closed.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const collegeDomain = requireEnv('COLLEGE_DOMAIN').toLowerCase();
  const usersTable = requireEnv('USERS_TABLE');

  const email = event.request.userAttributes['email']?.trim().toLowerCase();
  if (!email || !email.endsWith(`@${collegeDomain}`)) {
    throw new Error('Sign-up is limited to college email addresses.');
  }

  const result = await ddb.send(new GetCommand({ TableName: usersTable, Key: { email } }));
  if (!result.Item) {
    throw new Error('This email has not been registered. Ask your batch manager.');
  }

  return event;
};
