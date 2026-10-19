import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAttempt,
  claimAppeal,
  clearOverride,
  countTranscribeTry,
  releaseAppeal,
  getAnswer,
  listAnswersByExam,
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
    expect(input.UpdateExpression).toContain('REMOVE #failReason, #failDetail, #transcribeTries');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':one': 1,
      ':queued': 'QUEUED',
      ':imageKey': 'answers/exam-1/R1/q2.jpg',
    });
    expect(input.ReturnValues).toBe('UPDATED_NEW');
  });

  it('sets the attributes of the byExam index on every attempt, so no answer is ever unindexed', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { attempt: 1 } });

    await beginAttempt(key);

    const input = lastUpdate();
    expect(input.UpdateExpression).toContain(
      '#examId = :examId, #studentEmail = :studentEmail, #examSort = :examSort',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':examId': 'exam-1',
      ':studentEmail': 'student@college.edu',
      ':examSort': 'student@college.edu#2',
    });
    expect(input.ExpressionAttributeNames).toMatchObject({
      '#examId': 'examId',
      '#studentEmail': 'studentEmail',
      '#examSort': 'examSort',
    });
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

describe('countTranscribeTry', () => {
  it('adds one, only for the current attempt, and returns the new count', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { transcribeTries: 2 } });

    await expect(countTranscribeTry(key, 3)).resolves.toBe(2);

    const input = lastUpdate();
    expect(input.Key).toEqual(dbKey);
    expect(input.UpdateExpression).toBe('ADD #tries :one');
    expect(input.ConditionExpression).toBe('#attempt = :expectedAttempt');
    expect(input.ExpressionAttributeValues).toEqual({ ':one': 1, ':expectedAttempt': 3 });
    expect(input.ReturnValues).toBe('UPDATED_NEW');
  });

  it("is 'stale' when a newer attempt exists", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    await expect(countTranscribeTry(key, 1)).resolves.toBe('stale');
  });

  it('passes other errors through', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
    await expect(countTranscribeTry(key, 1)).rejects.toThrow('throttled');
  });

  it('starts again from zero for a new attempt and after any outcome', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { attempt: 2 } });
    await beginAttempt(key);
    expect(lastUpdate().UpdateExpression).toContain('#transcribeTries');
    expect(lastUpdate().UpdateExpression).toMatch(/REMOVE .*#transcribeTries/);

    ddbMock.on(UpdateCommand).resolves({});
    await markFailed(key, 2, 'GEMINI_ERROR', 'busy');
    expect(lastUpdate().UpdateExpression).toContain('#rm_transcribeTries');
    await saveTranscription(key, 2, {
      language: 'python',
      rawTranscription: 'r',
      correctedCode: 'c',
      driverCode: 'd',
      fixes: [],
      estimatedComplexity: 'O(n)',
      meetsComplexity: true,
    });
    expect(lastUpdate().UpdateExpression).toContain('#rm_transcribeTries');
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

  it('markFailed stores a readable detail, cut to 300 characters', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await markFailed(key, 2, 'GEMINI_ERROR', '  Gemini is busy, so wait a minute.  ');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({
      ':failDetail': 'Gemini is busy, so wait a minute.',
    });
    expect(lastUpdate().UpdateExpression).not.toContain('#rm_failDetail');

    await markFailed(key, 2, 'GEMINI_ERROR', 'x'.repeat(500));
    const stored = lastUpdate().ExpressionAttributeValues?.[':failDetail'] as string;
    expect(stored).toHaveLength(300);
    expect(stored.endsWith('...')).toBe(true);
  });

  it('markFailed gives the detail a full stop when it has none, and keeps one that it has', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await markFailed(key, 2, 'WORKER_ERROR', 'The photo could not be found');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({
      ':failDetail': 'The photo could not be found.',
    });

    await markFailed(key, 2, 'WORKER_ERROR', 'Is it readable?');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({
      ':failDetail': 'Is it readable?',
    });
  });

  it('markFailed without a detail clears any earlier one', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await markFailed(key, 2, 'UNREADABLE');
    expect(lastUpdate().UpdateExpression).toContain('#rm_failDetail');
    expect(lastUpdate().ExpressionAttributeValues).not.toHaveProperty(':failDetail');
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

describe('the open appeal marker', () => {
  it('claims with a condition that fails if one is open or the answer is missing', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(claimAppeal(key, 'a1')).resolves.toBe(true);

    const input = lastUpdate();
    expect(input.Key).toEqual(dbKey);
    expect(input.UpdateExpression).toBe('SET #open = :appealId');
    expect(input.ConditionExpression).toBe(
      'attribute_exists(examStudent) AND attribute_not_exists(#open)',
    );
    expect(input.ExpressionAttributeNames).toEqual({ '#open': 'openAppealId' });

    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    await expect(claimAppeal(key, 'a2')).resolves.toBe(false);
  });

  it('passes other errors through when claiming', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
    await expect(claimAppeal(key, 'a1')).rejects.toThrow('throttled');
  });

  it("releases only the appeal's own mark, and does not mind if it is gone", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await releaseAppeal(key, 'a1');
    expect(lastUpdate().UpdateExpression).toBe('REMOVE #open');
    expect(lastUpdate().ConditionExpression).toBe('#open = :appealId');

    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    await expect(releaseAppeal(key, 'someone-else')).resolves.toBeUndefined();

    ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
    await expect(releaseAppeal(key, 'a1')).rejects.toThrow('throttled');
  });
});

describe('listAnswersByExam', () => {
  it('reads a whole exam with queries on the byExam index, following every page', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ questionNumber: 1 }, { questionNumber: 2 }],
        LastEvaluatedKey: { examStudent: 'a', questionNumber: 2 },
      })
      .resolvesOnce({ Items: [{ questionNumber: 3 }] });

    const answers = await listAnswersByExam('exam-1');

    expect(answers).toHaveLength(3);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: 'Answers',
      IndexName: 'byExam',
      KeyConditionExpression: 'examId = :examId',
      ExpressionAttributeValues: { ':examId': 'exam-1' },
    });
    expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual({
      examStudent: 'a',
      questionNumber: 2,
    });
  });
});

describe('markFailed: the FailedToGrade metric', () => {
  const lines = () =>
    vi
      .mocked(console.log)
      .mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts one FailedToGrade when the failure is written', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await expect(markFailed(key, 2, 'UNREADABLE')).resolves.toBe('written');

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ FailedToGrade: 1, reason: 'UNREADABLE' });
  });

  it('counts nothing when a newer attempt made the write stale', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    await expect(markFailed(key, 2, 'UNREADABLE')).resolves.toBe('stale');

    expect(lines()).toEqual([]);
  });
});
