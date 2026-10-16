import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../errors.js';
import { TABLE_ENV, TABLE_NAMES } from '../tables.js';
import type { UserItem } from '../types.js';
import { putAuditItem, listAuditByActor, listAuditForEntity } from './audit-log.js';
import {
  createAppeal,
  findOpenAppeal,
  getAppeal,
  listAppealsByExam,
  updateAppeal,
} from './appeals.js';
import { createBatch, getBatch, listBatches } from './batches.js';
import { tableName } from './client.js';
import { getExam, listExamsByBatch, updateExam, createExam } from './exams.js';
import {
  getExamStudent,
  listExamStudents,
  listExamsForStudent,
  setAbsent,
  setTotals,
} from './exam-students.js';
import {
  createQuestion,
  getLatestQuestion,
  getQuestion,
  listQuestionsByTeacher,
  updateQuestion,
} from './questions.js';
import {
  createUser,
  getUser,
  getUserByRoll,
  listUsersByBatch,
  putUser,
  updateUser,
} from './users.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });

beforeEach(() => {
  ddbMock.reset();
  for (const name of TABLE_NAMES) process.env[TABLE_ENV[name]] = `t-${name}`;
});

const sent = <T>(command: new (...args: never[]) => T) =>
  ddbMock.commandCalls(command as never).map((c) => c.args[0].input as Record<string, unknown>);

describe('table names', () => {
  it('match the env vars that addRoute sets', () => {
    expect(TABLE_ENV).toEqual({
      Users: 'USERS_TABLE',
      Batches: 'BATCHES_TABLE',
      Questions: 'QUESTIONS_TABLE',
      Exams: 'EXAMS_TABLE',
      ExamStudents: 'EXAM_STUDENTS_TABLE',
      Answers: 'ANSWERS_TABLE',
      Appeals: 'APPEALS_TABLE',
      AuditLog: 'AUDIT_LOG_TABLE',
    });
  });

  it('are read from the environment', () => {
    expect(tableName('Users')).toBe('t-Users');
  });

  it('fail loudly when the env var is missing', () => {
    delete process.env['EXAMS_TABLE'];
    expect(() => tableName('Exams')).toThrow(/EXAMS_TABLE/);
  });
});

describe('Users', () => {
  const user: UserItem = { email: 'Teach@College.edu', role: 'TEACHER', name: 'T', active: true };

  it('gets by lower-cased email', async () => {
    ddbMock.on(GetCommand).resolves({});
    await getUser('Teach@College.edu');
    expect(sent(GetCommand)[0]).toEqual({
      TableName: 't-Users',
      Key: { email: 'teach@college.edu' },
    });
  });

  it('creates conditionally and maps a duplicate to 409', async () => {
    ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionFailed());

    await createUser(user);
    expect(sent(PutCommand)[0]).toMatchObject({
      TableName: 't-Users',
      ConditionExpression: 'attribute_not_exists(email)',
      Item: { email: 'teach@college.edu' },
    });
    await expect(createUser(user)).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores the email in lower case and the roll number in upper case', async () => {
    ddbMock.on(PutCommand).resolves({});
    const student: UserItem = {
      email: 'Student@College.EDU',
      role: 'STUDENT',
      name: 'S',
      active: true,
      rollNo: ' 22cs101 ',
      batchId: 'A',
    };

    await createUser(student);
    await putUser(student);

    for (const input of sent(PutCommand)) {
      expect(input['Item']).toMatchObject({ email: 'student@college.edu', rollNo: '22CS101' });
    }
  });

  it('upper-cases a changed roll number on update', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await updateUser('Student@College.edu', { rollNo: ' 22cs101 ', name: 'S' });

    expect(sent(UpdateCommand)[0]).toMatchObject({
      Key: { email: 'student@college.edu' },
      ExpressionAttributeValues: { ':rollNo': '22CS101', ':name': 'S' },
    });
  });

  it('looks a roll number up case-insensitively', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getUserByRoll(' 22cs101 ');

    expect(sent(QueryCommand)[0]).toMatchObject({
      IndexName: 'byRoll',
      ExpressionAttributeValues: { ':rollNo': '22CS101' },
    });
  });

  it('updates only an existing user', async () => {
    ddbMock.on(UpdateCommand).resolvesOnce({}).rejectsOnce(conditionFailed());

    await expect(updateUser('t@college.edu', { active: false })).resolves.toBe(true);
    expect(sent(UpdateCommand)[0]).toMatchObject({
      Key: { email: 't@college.edu' },
      ConditionExpression: 'attribute_exists(email)',
      ExpressionAttributeValues: { ':active': false },
    });
    await expect(updateUser('gone@college.edu', { active: false })).resolves.toBe(false);
  });

  it('queries the byBatch and byRoll indexes', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ email: 's@college.edu' }] });

    await listUsersByBatch('B1');
    await expect(getUserByRoll('R1')).resolves.toEqual({ email: 's@college.edu' });

    const [byBatch, byRoll] = sent(QueryCommand);
    expect(byBatch).toMatchObject({
      IndexName: 'byBatch',
      ExpressionAttributeValues: { ':batchId': 'B1' },
    });
    expect(byRoll).toMatchObject({
      IndexName: 'byRoll',
      ExpressionAttributeValues: { ':rollNo': 'R1' },
    });
  });

  it('follows pagination', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ email: 'a' }], LastEvaluatedKey: { email: 'a' } })
      .resolvesOnce({ Items: [{ email: 'b' }] });

    await expect(listUsersByBatch('B1')).resolves.toHaveLength(2);
    expect(sent(QueryCommand)[1]).toMatchObject({ ExclusiveStartKey: { email: 'a' } });
  });
});

describe('Batches', () => {
  it('gets by batchId, creates conditionally and lists with a scan', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionFailed());
    ddbMock.on(ScanCommand).resolves({ Items: [{ batchId: 'B1', name: 'One' }] });

    await getBatch('B1');
    expect(sent(GetCommand)[0]).toEqual({ TableName: 't-Batches', Key: { batchId: 'B1' } });

    await createBatch({ batchId: 'B1', name: 'One' });
    await expect(createBatch({ batchId: 'B1', name: 'One' })).rejects.toBeInstanceOf(ConflictError);
    expect(sent(PutCommand)[0]).toMatchObject({
      ConditionExpression: 'attribute_not_exists(batchId)',
    });

    await expect(listBatches()).resolves.toEqual([{ batchId: 'B1', name: 'One' }]);
  });
});

describe('Questions', () => {
  it('gets by questionId and numeric version', async () => {
    ddbMock.on(GetCommand).resolves({});
    await getQuestion('q1', 2);
    expect(sent(GetCommand)[0]).toEqual({
      TableName: 't-Questions',
      Key: { questionId: 'q1', version: 2 },
    });
  });

  it('finds the latest version with a descending, limit-1 query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ questionId: 'q1', version: 3 }] });

    await expect(getLatestQuestion('q1')).resolves.toEqual({ questionId: 'q1', version: 3 });
    expect(sent(QueryCommand)[0]).toMatchObject({ ScanIndexForward: false, Limit: 1 });
  });

  it('creates a version conditionally', async () => {
    ddbMock.on(PutCommand).rejects(conditionFailed());
    await expect(
      createQuestion({ questionId: 'q1', version: 1, teacherEmail: 'T@College.edu' } as never),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('updates an existing version and lists by teacher', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(updateQuestion('q1', 1, { testStatus: 'APPROVED' })).resolves.toBe(true);
    expect(sent(UpdateCommand)[0]).toMatchObject({
      Key: { questionId: 'q1', version: 1 },
      ExpressionAttributeValues: { ':testStatus': 'APPROVED' },
    });

    await listQuestionsByTeacher('T@College.edu');
    expect(sent(QueryCommand)[0]).toMatchObject({
      IndexName: 'byTeacher',
      ExpressionAttributeValues: { ':teacherEmail': 't@college.edu' },
    });
  });
});

describe('Exams', () => {
  it('gets, creates conditionally, updates and lists by batch', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).rejects(conditionFailed());
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getExam('e1');
    expect(sent(GetCommand)[0]).toEqual({ TableName: 't-Exams', Key: { examId: 'e1' } });
    await expect(createExam({ examId: 'e1' } as never)).rejects.toBeInstanceOf(ConflictError);
    await expect(updateExam('e1', { status: 'PUBLISHED' })).resolves.toBe(true);
    await listExamsByBatch('B1');
    expect(sent(QueryCommand)[0]).toMatchObject({ IndexName: 'byBatch' });
  });
});

describe('ExamStudents', () => {
  it('uses examId and studentEmail as the key', async () => {
    ddbMock.on(GetCommand).resolves({});
    await getExamStudent('e1', 'S@College.edu');
    expect(sent(GetCommand)[0]).toEqual({
      TableName: 't-ExamStudents',
      Key: { examId: 'e1', studentEmail: 's@college.edu' },
    });
  });

  it('marks absent and stores totals without clobbering absent', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await setAbsent('e1', 's@college.edu', true);
    await setTotals('e1', 's@college.edu', 12.5, 20);

    const [absent, totals] = sent(UpdateCommand);
    expect(absent).toMatchObject({ ExpressionAttributeValues: { ':absent': true } });
    expect(totals).toMatchObject({
      ExpressionAttributeValues: { ':totalScore': 12.5, ':maxScore': 20 },
    });
    expect(String(totals?.['UpdateExpression'])).toContain('if_not_exists(absent');
  });

  it('lists by exam and by student index', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await listExamStudents('e1');
    await listExamsForStudent('S@College.edu');
    const [byExam, byStudent] = sent(QueryCommand);
    expect(byExam).toMatchObject({ KeyConditionExpression: 'examId = :examId' });
    expect(byStudent).toMatchObject({
      IndexName: 'byStudent',
      ExpressionAttributeValues: { ':studentEmail': 's@college.edu' },
    });
  });
});

describe('Appeals', () => {
  const appeal = {
    appealId: 'a1',
    examId: 'e1',
    studentEmail: 's@college.edu',
    questionNumber: 2,
    message: 'm',
    status: 'OPEN' as const,
    createdAt: '2026-10-17T00:00:00.000Z',
  };

  it('gets by appealId and creates conditionally', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).rejects(conditionFailed());
    await getAppeal('a1');
    expect(sent(GetCommand)[0]).toEqual({ TableName: 't-Appeals', Key: { appealId: 'a1' } });
    await expect(createAppeal(appeal)).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists by exam and status through the byExam index', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await listAppealsByExam('e1', 'OPEN');
    await listAppealsByExam('e1');
    const [withStatus, withoutStatus] = sent(QueryCommand);
    expect(withStatus).toMatchObject({
      IndexName: 'byExam',
      KeyConditionExpression: 'examId = :examId AND #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':examId': 'e1', ':status': 'OPEN' },
    });
    expect(withoutStatus).toMatchObject({ KeyConditionExpression: 'examId = :examId' });
    expect(withoutStatus).not.toHaveProperty('ExpressionAttributeNames');
  });

  it('finds the open appeal for one student and question only', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { ...appeal, appealId: 'other-student', studentEmail: 'x@college.edu' },
        { ...appeal, appealId: 'other-question', questionNumber: 3 },
        appeal,
      ],
    });
    await expect(findOpenAppeal('e1', 'S@College.edu', 2)).resolves.toMatchObject({
      appealId: 'a1',
    });
  });

  it('updates an existing appeal', async () => {
    ddbMock.on(UpdateCommand).resolvesOnce({}).rejectsOnce(conditionFailed());
    await expect(updateAppeal('a1', { status: 'CLOSED', note: 'ok' })).resolves.toBe(true);
    await expect(updateAppeal('nope', { status: 'CLOSED' })).resolves.toBe(false);
  });
});

describe('AuditLog', () => {
  it('writes conditionally on the entity key', async () => {
    ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionFailed());
    const item = {
      entityKey: 'k',
      timestamp: '2026-10-17T00:00:00.000Z',
      actor: 'a@b.co',
      action: 'A',
      before: null,
      after: null,
      reason: 'r',
    };
    await expect(putAuditItem(item)).resolves.toBe(true);
    await expect(putAuditItem(item)).resolves.toBe(false);
    expect(sent(PutCommand)[0]).toMatchObject({
      TableName: 't-AuditLog',
      ConditionExpression: 'attribute_not_exists(entityKey)',
    });
  });

  it('reads by entity and through the byActor index', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await listAuditForEntity('k');
    await listAuditByActor('Admin@College.edu');
    const [byEntity, byActor] = sent(QueryCommand);
    expect(byEntity).toMatchObject({ KeyConditionExpression: 'entityKey = :entityKey' });
    expect(byActor).toMatchObject({
      IndexName: 'byActor',
      ExpressionAttributeValues: { ':actor': 'admin@college.edu' },
    });
  });
});
