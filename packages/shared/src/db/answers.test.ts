import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginAttempt,
  clearOverride,
  getAnswer,
  listAnswersForStudent,
  markFailed,
  recordAnswerResult,
  saveTranscription,
  setAnswerStatus,
  setOverride,
  type AnswerKey,
} from './answers.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const key: AnswerKey = { examId: 'exam-1', studentEmail: 'Student@College.edu', questionNumber: 2 };
const dbKey = { examStudent: 'exam-1#student@college.edu', questionNumber: 2 };

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });

const lastUpdate = () => {
  const calls = ddbMock.commandCalls(UpdateCommand);
  const input = calls[calls.length - 1]?.args[0].input;
  if (!input) throw new Error('No UpdateCommand was sent');
  return input;
};

beforeEach(() => {
  ddbMock.reset();
  process.env['ANSWERS_TABLE'] = 'Answers';
});

describe('keys', () => {
  it('uses examId#studentEmail as the partition key and a numeric question number', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { attempt: 1 } });
    await getAnswer(key);
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: 'Answers',
      Key: dbKey,
    });
  });

  it('lists a student’s answers with a single partition query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ questionNumber: 1 }] });
    await expect(listAnswersForStudent('exam-1', 'Student@College.edu')).resolves.toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'Answers',
      KeyConditionExpression: 'examStudent = :examStudent',
      ExpressionAttributeValues: { ':examStudent': 'exam-1#student@college.edu' },
    });
  });
});

describe('beginAttempt', () => {
  it('atomically increments the attempt and returns it', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { attempt: 3 } });

    await expect(beginAttempt(key, 'answers/exam-1/R1/q2.jpg')).resolves.toBe(3);

    const input = lastUpdate();
    expect(input.Key).toEqual(dbKey);
    expect(input.UpdateExpression).toContain('ADD #attempt :one');
    expect(input.UpdateExpression).toContain('#status = :queued');
    expect(input.UpdateExpression).toContain('REMOVE #failReason');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':one': 1,
      ':queued': 'QUEUED',
      ':imageKey': 'answers/exam-1/R1/q2.jpg',
    });
    expect(input.ReturnValues).toBe('UPDATED_NEW');
  });

  it('keeps the stored image on a re-run', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { attempt: 4 } });

    await beginAttempt(key);

    expect(lastUpdate().UpdateExpression).not.toContain('imageKey');
  });
});

describe('recordAnswerResult: the conditional write', () => {
  const result = {
    testsPassed: 7,
    testsTotal: 10,
    score: 3.5,
    verdicts: [{ index: 0, kind: 'small' as const, verdict: 'AC' as const }],
  };

  it('only writes when the stored attempt equals the message attempt', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await expect(recordAnswerResult(key, 3, result)).resolves.toBe('written');

    const input = lastUpdate();
    expect(input.ConditionExpression).toBe('#attempt = :expectedAttempt');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#attempt': 'attempt' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':expectedAttempt': 3,
      ':testsPassed': 7,
      ':testsTotal': 10,
      ':score': 3.5,
      ':status': 'GRADED',
    });
    expect(input.Key).toEqual(dbKey);
  });

  it('never touches the override', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await recordAnswerResult(key, 1, result);

    const input = lastUpdate();
    expect(JSON.stringify(input)).not.toContain('override');
  });

  it('reports stale when an older run loses to a newer attempt', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    await expect(recordAnswerResult(key, 2, result)).resolves.toBe('stale');
  });

  it('reports stale when the answer no longer exists', async () => {
    // A missing item fails `attempt = :expectedAttempt` as well, so DynamoDB answers the same way.
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    await expect(recordAnswerResult({ ...key, questionNumber: 99 }, 1, result)).resolves.toBe(
      'stale',
    );
  });

  it('lets other errors through', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceeded'));

    await expect(recordAnswerResult(key, 1, result)).rejects.toThrow(
      'ProvisionedThroughputExceeded',
    );
  });
});

describe('other stage writes are guarded by the attempt too', () => {
  it.each([
    ['setAnswerStatus', () => setAnswerStatus(key, 2, 'TRANSCRIBING')],
    ['markFailed', () => markFailed(key, 2, 'UNREADABLE')],
    [
      'saveTranscription',
      () =>
        saveTranscription(key, 2, {
          language: 'python',
          rawTranscription: 'raw',
          correctedCode: 'code',
          driverCode: 'driver',
          fixes: [],
          estimatedComplexity: 'O(n)',
          meetsComplexity: true,
        }),
    ],
  ])('%s', async (_name, run) => {
    ddbMock.on(UpdateCommand).resolvesOnce({}).rejectsOnce(conditionFailed());

    await expect(run()).resolves.toBe('written');
    expect(lastUpdate().ConditionExpression).toBe('#attempt = :expectedAttempt');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({ ':expectedAttempt': 2 });

    await expect(run()).resolves.toBe('stale');
  });

  it('markFailed sets FAILED_TO_GRADE with the reason', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await markFailed(key, 2, 'GEMINI_ERROR');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({
      ':status': 'FAILED_TO_GRADE',
      ':failReason': 'GEMINI_ERROR',
    });
  });

  it('saveTranscription moves the answer to RUNNING', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await saveTranscription(key, 2, {
      language: 'cpp',
      rawTranscription: 'raw',
      correctedCode: 'code',
      driverCode: 'driver',
      fixes: ['added semicolon'],
      estimatedComplexity: 'O(n log n)',
      meetsComplexity: false,
    });
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({
      ':status': 'RUNNING',
      ':language': 'cpp',
      ':meetsComplexity': false,
    });
  });
});

describe('overrides', () => {
  it('sets an override on an existing answer', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const override = {
      score: 8,
      reason: 'Misread loop bound',
      by: 'admin@college.edu',
      at: '2026-10-17T00:00:00.000Z',
    };

    await setOverride(key, override);

    const input = lastUpdate();
    expect(input.Key).toEqual(dbKey);
    expect(input.ConditionExpression).toBe('attribute_exists(examStudent)');
    expect(input.ExpressionAttributeValues).toEqual({ ':override': override });
  });

  it('clears an override', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await clearOverride(key);

    expect(lastUpdate().UpdateExpression).toBe('REMOVE #override');
  });
});
