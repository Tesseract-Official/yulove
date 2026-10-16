import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { answerEntityKey, writeAudit } from './audit.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
const fixedNow = () => new Date('2026-10-17T10:00:00.000Z');

beforeEach(() => {
  ddbMock.reset();
  process.env['AUDIT_LOG_TABLE'] = 'AuditLog';
});

describe('writeAudit', () => {
  it('writes the entry with an ISO timestamp key', async () => {
    ddbMock.on(PutCommand).resolves({});

    const timestamp = await writeAudit(
      'answer#exam-1#s@college.edu#2',
      'Admin@College.edu',
      'OVERRIDE_SCORE',
      { score: 3 },
      { score: 8 },
      'Misread loop bound',
      fixedNow,
    );

    expect(timestamp).toBe('2026-10-17T10:00:00.000Z');
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toEqual({
      TableName: 'AuditLog',
      Item: {
        entityKey: 'answer#exam-1#s@college.edu#2',
        timestamp: '2026-10-17T10:00:00.000Z',
        actor: 'admin@college.edu',
        action: 'OVERRIDE_SCORE',
        before: { score: 3 },
        after: { score: 8 },
        reason: 'Misread loop bound',
      },
      ConditionExpression: 'attribute_not_exists(entityKey)',
    });
  });

  it('never overwrites: a same-millisecond collision moves 1 ms on', async () => {
    ddbMock.on(PutCommand).rejectsOnce(conditionFailed()).resolves({});

    const timestamp = await writeAudit('k', 'a@b.co', 'A', null, null, 'r', fixedNow);

    expect(timestamp).toBe('2026-10-17T10:00:00.001Z');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
  });

  it('gives up after repeated collisions', async () => {
    ddbMock.on(PutCommand).rejects(conditionFailed());

    await expect(writeAudit('k', 'a@b.co', 'A', null, null, 'r', fixedNow)).rejects.toThrow(
      /audit entry/,
    );
  });

  it('passes other errors through', async () => {
    ddbMock.on(PutCommand).rejects(new Error('AccessDenied'));

    await expect(writeAudit('k', 'a@b.co', 'A', null, null, 'r', fixedNow)).rejects.toThrow(
      'AccessDenied',
    );
  });
});

describe('answerEntityKey', () => {
  it('is built from the exam, lower-cased student and question number', () => {
    expect(answerEntityKey('exam-1', 'S@College.edu', 2)).toBe('answer#exam-1#s@college.edu#2');
  });
});
