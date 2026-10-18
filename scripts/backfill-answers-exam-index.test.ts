import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillAnswersExamIndex, describeResult } from './backfill-answers-exam-index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'already indexed', $metadata: {} });

const old = (examStudent: string, questionNumber: number) => ({ examStudent, questionNumber });

beforeEach(() => ddbMock.reset());

describe('backfillAnswersExamIndex', () => {
  it('gives each unindexed answer examId, studentEmail and examSort, across pages', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [old('exam-1#a@college.edu', 1), old('exam-1#a@college.edu', 2)],
        LastEvaluatedKey: { examStudent: 'exam-1#a@college.edu', questionNumber: 2 },
      })
      .resolvesOnce({ Items: [old('exam-2#B@college.edu', 10)] });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await backfillAnswersExamIndex(client, 'Answers');

    expect(result).toEqual({ scanned: 3, alreadyIndexed: 0, updated: 3, raced: 0, malformed: [] });
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(3);
    expect(updates).toContainEqual({
      TableName: 'Answers',
      Key: { examStudent: 'exam-2#B@college.edu', questionNumber: 10 },
      UpdateExpression: 'SET examId = :examId, studentEmail = :studentEmail, examSort = :examSort',
      ConditionExpression: 'attribute_exists(examStudent) AND attribute_not_exists(examSort)',
      ExpressionAttributeValues: {
        ':examId': 'exam-2',
        ':studentEmail': 'b@college.edu',
        ':examSort': 'b@college.edu#10',
      },
    });
    expect(ddbMock.commandCalls(ScanCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
      examStudent: 'exam-1#a@college.edu',
      questionNumber: 2,
    });
  });

  it('leaves answers that already have the index attributes alone', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { ...old('exam-1#a@college.edu', 1), examSort: 'a@college.edu#1' },
        old('exam-1#a@college.edu', 2),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await backfillAnswersExamIndex(client, 'Answers');

    expect(result).toMatchObject({ scanned: 2, alreadyIndexed: 1, updated: 1 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it('writes nothing in a dry run, but still counts what it would do', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [old('exam-1#a@college.edu', 1)] });

    const result = await backfillAnswersExamIndex(client, 'Answers', { dryRun: true });

    expect(result.updated).toBe(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('is safe to run twice: an answer indexed meanwhile is counted, not overwritten or failed', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [old('exam-1#a@college.edu', 1)] });
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    const result = await backfillAnswersExamIndex(client, 'Answers');

    expect(result).toMatchObject({ updated: 0, raced: 1 });
  });

  it('reports a key it cannot split and leaves it alone', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [old('no-hash-here', 1)] });

    const result = await backfillAnswersExamIndex(client, 'Answers');

    expect(result.malformed).toEqual(['no-hash-here']);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('throws real errors', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [old('exam-1#a@college.edu', 1)] });
    ddbMock.on(UpdateCommand).rejects(new Error('AccessDenied'));
    await expect(backfillAnswersExamIndex(client, 'Answers')).rejects.toThrow('AccessDenied');
  });

  it('reads only the key fields, not the transcriptions', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    await backfillAnswersExamIndex(client, 'Answers');
    expect(ddbMock.commandCalls(ScanCommand)[0]?.args[0].input.ProjectionExpression).toBe(
      'examStudent, questionNumber, examSort',
    );
  });
});

describe('describeResult', () => {
  it('says what a dry run would do', () => {
    const lines = describeResult(
      { scanned: 4, alreadyIndexed: 1, updated: 3, raced: 0, malformed: [] },
      true,
    );
    expect(lines).toContain('3 would be updated (dry run, nothing written).');
  });
});

describe('the command', () => {
  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'backfill-answers-exam-index.ts'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
