import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { normaliseEmail, signInProblem, type UserItem } from '@yulove/shared';
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
 * Cognito pre-sign-up trigger, run when someone signs in for the first time. Whether they may is
 * decided by their Users record alone (see signInProblem): they must be registered and active;
 * teachers, batch managers and super admins may use any email address, students only one on the
 * college domain. Throwing rejects the sign-up, so every failure path (unknown user, wrong domain
 * for a student, deactivated, lookup error) fails closed. Later requests are checked again by
 * requireUser, which is why a deactivation or role change takes effect at once.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const collegeDomain = requireEnv('COLLEGE_DOMAIN').toLowerCase();
  const usersTable = requireEnv('USERS_TABLE');

  const raw = event.request.userAttributes['email'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Your Google account did not give an email address.');
  }
  const email = normaliseEmail(raw);

  const result = await ddb.send(new GetCommand({ TableName: usersTable, Key: { email } }));
  const problem = signInProblem(result.Item as UserItem | undefined, email, collegeDomain);
  if (problem) throw new Error(problem);

  return event;
};
