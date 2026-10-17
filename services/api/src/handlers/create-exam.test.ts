import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { ExamItem, ExamStudentItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { examRequest, seedExamWorld } from '../test-utils/exams.js';
import { OTHER_TEACHER, TEACHER } from '../test-utils/questions.js';
import { handler } from './create-exam.js';

const db = new FakeDb();
const call = (email: string, body: unknown) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/exams', email, body }));

const exams = () => db.all<ExamItem>('Exams');
const rows = () => db.all<ExamStudentItem>('ExamStudents');

beforeEach(() => {
  db.reset();
  seedExamWorld(db);
});

describe('POST /exams: success', () => {
  it('creates a DRAFT exam owned by the teacher', async () => {
    const { status, body } = await call(TEACHER, examRequest());

    expect(status).toBe(201);
    expect(body.exam).toMatchObject({
      batchId: 'A',
      title: 'Week 3 test',
      date: '2026-10-24',
      createdBy: TEACHER,
      status: 'DRAFT',
      questions: examRequest().questions,
    });
    expect(body.exam.examId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.exam).not.toHaveProperty('pdfKey');
    expect(exams()).toEqual([body.exam]);
  });

  it('gives every exam its own id', async () => {
    const a = await call(TEACHER, examRequest());
    const b = await call(TEACHER, examRequest());
    expect(a.body.exam.examId).not.toBe(b.body.exam.examId);
  });

  it('keeps only the fields it stores for each question', async () => {
    const { body } = await call(TEACHER, {
      ...examRequest(),
      questions: [{ number: 1, questionId: 'q1', version: 1, marks: 2.5, extra: 'x' }],
    });
    expect(body.exam.questions).toEqual([{ number: 1, questionId: 'q1', version: 1, marks: 2.5 }]);
  });

  it('lets a super admin create an exam for any batch with any teacher’s questions', async () => {
    const { status, body } = await call('super-admin@college.edu', {
      ...examRequest({ batchId: 'B' }),
      questions: [{ number: 1, questionId: 'q5', version: 1, marks: 4 }],
    });

    expect(status).toBe(201);
    expect(body.exam.createdBy).toBe('super-admin@college.edu');
  });
});

describe('POST /exams: the students of the batch', () => {
  it('creates a row for every active student, and for nobody else', async () => {
    const { body } = await call(TEACHER, examRequest());

    const created = rows()
      .map((r) => r.studentEmail)
      .sort();
    expect(created).toEqual(['s1@college.edu', 's2@college.edu', 's3@college.edu']);
    expect(rows().every((r) => r.examId === body.exam.examId && r.absent === false)).toBe(true);
    expect(body.studentRows).toEqual({ created: 3, pending: 0 });
    // Not the inactive student, not a student of another batch, not staff.
    expect(created).not.toContain('inactive@college.edu');
    expect(created).not.toContain('other-batch@college.edu');
    expect(created).not.toContain(TEACHER);
  });

  it('writes the rows in batches of 25, not one by one', async () => {
    for (let i = 10; i < 70; i += 1) {
      db.addUser(
        userOf('STUDENT', { email: `bulk${i}@college.edu`, batchId: 'A', rollNo: `B${i}` }),
      );
    }

    const { body } = await call(TEACHER, examRequest());

    expect(body.studentRows).toEqual({ created: 63, pending: 0 });
    expect(rows()).toHaveLength(63);
    const batches = db.commandCalls(BatchWriteCommand);
    expect(batches).toHaveLength(3); // 25 + 25 + 13
    const sizes = batches.map(
      (c) =>
        Object.values((c.input as { RequestItems: Record<string, unknown[]> }).RequestItems)[0]
          ?.length,
    );
    expect(sizes).toEqual([25, 25, 13]);
  });

  it('creates no rows for a batch with no students', async () => {
    db.addBatch('C', 'Empty');

    const { status, body } = await call('super-admin@college.edu', examRequest({ batchId: 'C' }));

    expect(status).toBe(201);
    expect(body.studentRows).toEqual({ created: 0, pending: 0 });
    expect(db.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('still creates the exam when the rows cannot be written (they are made on first access)', async () => {
    db.batchWriteMode = 'throw';

    const { status, body } = await call(TEACHER, examRequest());

    expect(status).toBe(201);
    expect(exams()).toHaveLength(1);
    expect(rows()).toEqual([]);
    expect(body.studentRows).toEqual({ created: 0, pending: 3 });
  });
});

describe('POST /exams: validation', () => {
  it.each([['unknown batch', { batchId: 'NOPE' }]])(
    'answers 422 for an %s (super admin)',
    async (_label, change) => {
      const { status } = await call('super-admin@college.edu', examRequest(change));
      expect(status).toBe(422);
      expect(exams()).toEqual([]);
    },
  );

  it('refuses a batch the teacher is not assigned to with 403, and creates nothing', async () => {
    const { status } = await call(TEACHER, examRequest({ batchId: 'B' }));

    expect(status).toBe(403);
    expect(exams()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('refuses a teacher with no batches at all', async () => {
    db.addUser(userOf('TEACHER', { email: 'new-teacher@college.edu', batchIds: [] }));
    expect((await call('new-teacher@college.edu', examRequest())).status).toBe(403);
  });

  it.each([
    [
      'a question that does not exist',
      [{ number: 1, questionId: 'nope', version: 1, marks: 5 }],
      422,
      /Unknown questions: nope v1/,
    ],
    [
      'a version that does not exist',
      [{ number: 1, questionId: 'q1', version: 7, marks: 5 }],
      422,
      /q1 v7/,
    ],
    [
      'a question still under review',
      [{ number: 1, questionId: 'q3', version: 1, marks: 5 }],
      422,
      /Not approved: q3 v1/,
    ],
    [
      'a question without tests',
      [{ number: 1, questionId: 'q4', version: 1, marks: 5 }],
      422,
      /q4 v1/,
    ],
    [
      'another teacher’s question',
      [{ number: 1, questionId: 'q5', version: 1, marks: 5 }],
      403,
      /another teacher/,
    ],
  ])('refuses %s', async (_label, questions, expectedStatus, message) => {
    const { status, body } = await call(TEACHER, examRequest({ questions }));

    expect(status).toBe(expectedStatus);
    expect(body.error.message).toMatch(message);
    expect(exams()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('names every unapproved question, not just the first', async () => {
    const { body } = await call(
      TEACHER,
      examRequest({
        questions: [
          { number: 1, questionId: 'q3', version: 1, marks: 5 },
          { number: 2, questionId: 'q1', version: 1, marks: 5 },
          { number: 3, questionId: 'q4', version: 1, marks: 5 },
        ],
      }),
    );
    expect(body.error.message).toContain('q3 v1');
    expect(body.error.message).toContain('q4 v1');
    expect(body.error.message).not.toContain('q1 v1');
  });

  it.each([
    ['zero marks', { questions: [{ number: 1, questionId: 'q1', version: 1, marks: 0 }] }],
    ['negative marks', { questions: [{ number: 1, questionId: 'q1', version: 1, marks: -2 }] }],
    ['no questions', { questions: [] }],
    [
      'question numbers that skip one',
      {
        questions: [
          { number: 1, questionId: 'q1', version: 1, marks: 5 },
          { number: 3, questionId: 'q2', version: 1, marks: 5 },
        ],
      },
    ],
    [
      'question numbers out of order',
      {
        questions: [
          { number: 2, questionId: 'q1', version: 1, marks: 5 },
          { number: 1, questionId: 'q2', version: 1, marks: 5 },
        ],
      },
    ],
    [
      'numbers starting at 0',
      { questions: [{ number: 0, questionId: 'q1', version: 1, marks: 5 }] },
    ],
    ['a bad date', { date: 'tomorrow' }],
    ['an empty title', { title: ' ' }],
    ['a bad batch id', { batchId: 'not valid!' }],
  ])('answers 422 for %s', async (_label, change) => {
    expect((await call(TEACHER, { ...examRequest(), ...change })).status).toBe(422);
    expect(exams()).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['a body that is not JSON', 'not json'],
  ])('answers 422 for %s', async (_label, body) => {
    expect((await call(TEACHER, body)).status).toBe(422);
  });
});

describe('POST /exams: who may call it', () => {
  it.each(deniedRoles('TEACHER'))('refuses a %s with 403 and creates nothing', async (role) => {
    expect(
      (await call(userOf(role, { batchIds: ['A'], batchId: 'A' }).email, examRequest())).status,
    ).toBe(403);
    expect(exams()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('refuses a deactivated teacher', async () => {
    db.addUser(userOf('TEACHER', { email: 'gone@college.edu', batchIds: ['A'], active: false }));
    expect((await call('gone@college.edu', examRequest())).status).toBe(403);
  });

  it('refuses a request with no identity', async () => {
    const { status } = await invoke(
      handler,
      makeEvent({ method: 'POST', path: '/exams', body: examRequest() }),
    );
    expect(status).toBe(401);
  });

  it('does not let a teacher use a question of OTHER_TEACHER even when it is approved', async () => {
    expect(OTHER_TEACHER).not.toBe(TEACHER);
    const { status } = await call(
      TEACHER,
      examRequest({ questions: [{ number: 1, questionId: 'q5', version: 1, marks: 1 }] }),
    );
    expect(status).toBe(403);
  });
});
