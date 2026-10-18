import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from '../errors.js';
import { normaliseEmail, normaliseRollNo } from '../identity.js';
import type { UserItem } from '../types.js';
import { buildSet, docClient, isConditionalCheckFailure, queryAll, tableName } from './client.js';

const table = () => tableName('Users');

/** The stored form of a user: lower-case email, upper-case roll number. */
function normaliseUser(user: UserItem): UserItem {
  return {
    ...user,
    email: normaliseEmail(user.email),
    ...(user.rollNo === undefined ? {} : { rollNo: normaliseRollNo(user.rollNo) }),
  };
}

export async function getUser(email: string): Promise<UserItem | undefined> {
  const out = await docClient().send(
    new GetCommand({ TableName: table(), Key: { email: normaliseEmail(email) } }),
  );
  return out.Item as UserItem | undefined;
}

/** Creates a user; throws ConflictError (409) if the email already exists. */
export async function createUser(user: UserItem): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: table(),
        Item: normaliseUser(user),
        ConditionExpression: 'attribute_not_exists(email)',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailure(error)) throw new ConflictError(`${user.email} already exists`);
    throw error;
  }
}

/** Writes a user, replacing any existing item (used by the CSV import to update rows). */
export async function putUser(user: UserItem): Promise<void> {
  await docClient().send(new PutCommand({ TableName: table(), Item: normaliseUser(user) }));
}

export type UserUpdate = Partial<
  Pick<UserItem, 'name' | 'batchIds' | 'active' | 'rollNo' | 'batchId'>
>;

/** Updates fields of an existing user. Returns false when the user does not exist. */
export async function updateUser(email: string, changes: UserUpdate): Promise<boolean> {
  const set = buildSet({
    ...changes,
    ...(changes.rollNo === undefined ? {} : { rollNo: normaliseRollNo(changes.rollNo) }),
  });
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: { email: normaliseEmail(email) },
        UpdateExpression: set.expression,
        ConditionExpression: 'attribute_exists(email)',
        ExpressionAttributeNames: set.names,
        ExpressionAttributeValues: set.values,
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
}

/** Students of a batch (index byBatch). */
export function listUsersByBatch(batchId: string): Promise<UserItem[]> {
  return queryAll<UserItem>({
    TableName: table(),
    IndexName: 'byBatch',
    KeyConditionExpression: 'batchId = :batchId',
    ExpressionAttributeValues: { ':batchId': batchId },
  });
}

/** Finds a student by roll number (index byRoll). */
export async function getUserByRoll(rollNo: string): Promise<UserItem | undefined> {
  const [first] = await queryAll<UserItem>({
    TableName: table(),
    IndexName: 'byRoll',
    KeyConditionExpression: 'rollNo = :rollNo',
    ExpressionAttributeValues: { ':rollNo': normaliseRollNo(rollNo) },
  });
  return first;
}

/**
 * Every teacher and batch manager. The Users table has no index by role, so this scans it with a
 * filter; the table is small (one college), and the filter keeps students out of the response.
 */
export async function listStaff(): Promise<UserItem[]> {
  const items: UserItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: '#role IN (:teacher, :manager)',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':teacher': 'TEACHER', ':manager': 'BATCH_MANAGER' },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((page.Items ?? []) as UserItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  // A filter is the database's job, but never let a student through if a test double ignores it.
  return items.filter((u) => u.role === 'TEACHER' || u.role === 'BATCH_MANAGER');
}

/** Every super admin (the founders), active or not. Scans the small Users table like listStaff. */
export async function listSuperAdmins(): Promise<UserItem[]> {
  const items: UserItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient().send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: '#role = :admin',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':admin': 'SUPER_ADMIN' },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((page.Items ?? []) as UserItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items.filter((u) => u.role === 'SUPER_ADMIN');
}
