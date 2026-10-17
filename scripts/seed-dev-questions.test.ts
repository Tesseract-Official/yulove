import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_QUESTIONS, DEV_TEACHER, seedDevQuestions } from './seed-dev-questions.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });

beforeEach(() => ddbMock.reset());

describe('the sample questions', () => {
  it('are "Sum of array" and "Reverse a string" with the right signatures', () => {
    expect(DEV_QUESTIONS.map((q) => [q.title, q.signature])).toEqual([
      [
        'Sum of array',
        {
          name: 'sumArray',
          parameters: [{ name: 'nums', type: 'int[]' }],
          returnType: 'int',
        },
      ],
      [
        'Reverse a string',
        {
          name: 'reverseString',
          parameters: [{ name: 's', type: 'string' }],
          returnType: 'string',
        },
      ],
    ]);
  });

  it('are owned by the founder, target O(n), marked dev and look approved', () => {
    expect(DEV_TEACHER).toBe('meloovegupta@gmail.com');
    for (const q of DEV_QUESTIONS) {
      expect(q).toMatchObject({
        teacherEmail: 'meloovegupta@gmail.com',
        version: 1,
        targetComplexity: 'O(n)',
        testStatus: 'APPROVED',
        dev: true,
      });
      expect(q.statement.length).toBeGreaterThan(10);
      expect(q.constraints.length).toBeGreaterThan(5);
      expect(q.examples).toHaveLength(1);
    }
  });

  it('have fixed, distinct, recognisable ids and examples that follow the JSON convention', () => {
    expect(DEV_QUESTIONS.map((q) => q.questionId)).toEqual(['dev-sum-array', 'dev-reverse-string']);
    for (const q of DEV_QUESTIONS) {
      const input = JSON.parse(q.examples[0]?.input ?? '') as Record<string, unknown>;
      expect(Object.keys(input)).toEqual(q.signature?.parameters.map((p) => p.name));
      expect(() => JSON.parse(q.examples[0]?.output ?? '')).not.toThrow();
    }
  });
});

describe('seedDevQuestions', () => {
  it('writes both questions with a condition that never overwrites', async () => {
    ddbMock.on(PutCommand).resolves({});

    const outcomes = await seedDevQuestions(client, 'Questions');

    expect(outcomes).toEqual([
      { questionId: 'dev-sum-array', status: 'created' },
      { questionId: 'dev-reverse-string', status: 'created' },
    ]);
    const puts = ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input);
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.TableName).toBe('Questions');
      expect(put.ConditionExpression).toBe('attribute_not_exists(questionId)');
      expect(put.Item?.['dev']).toBe(true);
    }
  });

  it('leaves questions that already exist alone and still adds the others', async () => {
    ddbMock.on(PutCommand).rejectsOnce(conditionFailed()).resolves({});

    expect(await seedDevQuestions(client, 'Questions')).toEqual([
      { questionId: 'dev-sum-array', status: 'already-exists' },
      { questionId: 'dev-reverse-string', status: 'created' },
    ]);
  });

  it('is repeatable: a second run changes nothing', async () => {
    ddbMock.on(PutCommand).rejects(conditionFailed());
    const outcomes = await seedDevQuestions(client, 'Questions');
    expect(outcomes.every((o) => o.status === 'already-exists')).toBe(true);
  });

  it('passes other errors through', async () => {
    ddbMock.on(PutCommand).rejects(new Error('AccessDenied'));
    await expect(seedDevQuestions(client, 'Questions')).rejects.toThrow('AccessDenied');
  });
});

describe('running the script', () => {
  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'seed-dev-questions.ts'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
