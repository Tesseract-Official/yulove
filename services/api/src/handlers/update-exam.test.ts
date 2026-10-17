import type { ExamItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem, examRequest, seedExamWorld } from '../test-utils/exams.js';
import { OTHER_TEACHER, TEACHER, questionItem, signature } from '../test-utils/questions.js';
import { handler } from './update-exam.js';

const db = new FakeDb();
const call = (email: string, body: unknown, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({ method: 'PUT', path: `/exams/${id}`, email, pathParameters: { id }, body }),
  );

const stored = () => db.get<ExamItem>('Exams', { examId: EXAM_ID });
const ready = () => examItem({ status: 'READY', pdfKey: `exams/${EXAM_ID}/paper.pdf` });

const answer = (email: string) =>
  db.put('Answers', {
    examStudent: `${EXAM_ID}#${email}`,
    questionNumber: 1,
    attempt: 1,
    status: 'QUEUED',
  });

beforeEach(() => {
  db.reset();
  seedExamWorld(db);
  db.put('Exams', ready());
});

describe('PUT /exams/{id}: changing a READY exam sends it back to DRAFT', () => {
  it.each([
    [
      'the marks',
      {
        questions: [
          { number: 1, questionId: 'q1', version: 1, marks: 12 },
          { number: 2, questionId: 'q2', version: 1, marks: 5 },
        ],
      },
    ],
    [
      'a question',
      {
        questions: [
          { number: 1, questionId: 'q2', version: 1, marks: 10 },
          { number: 2, questionId: 'q1', version: 1, marks: 5 },
        ],
      },
    ],
    [
      'the number of questions',
      { questions: [{ number: 1, questionId: 'q1', version: 1, marks: 10 }] },
    ],
    ['the title', { title: 'Week 3 retest' }],
    ['the date', { date: '2026-10-31' }],
  ])('changing %s', async (_label, change) => {
    const { status, body } = await call(TEACHER, examRequest(change));

    expect(status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.exam.status).toBe('DRAFT');
    expect(body.exam).not.toHaveProperty('pdfKey');

    expect(stored()?.status).toBe('DRAFT');
    expect(stored()).not.toHaveProperty('pdfKey'); // the old PDF is no longer offered
    expect(stored()).toMatchObject({ ...change, createdBy: TEACHER, batchId: 'A' });
  });

  it('a request that changes nothing leaves a READY exam READY, with its PDF', async () => {
    const { status, body } = await call(TEACHER, examRequest());

    expect(status).toBe(200);
    expect(body.changed).toBe(false);
    expect(stored()).toEqual(ready());
  });

  it('keeps the creator, the batch and the id', async () => {
    await call('super-admin@college.edu', examRequest({ title: 'Renamed' }));
    expect(stored()).toMatchObject({
      examId: EXAM_ID,
      createdBy: TEACHER,
      batchId: 'A',
      title: 'Renamed',
    });
  });

  it('is fine for an exam that is already DRAFT', async () => {
    db.put('Exams', examItem());
    const { status } = await call(TEACHER, examRequest({ title: 'Another title' }));
    expect(status).toBe(200);
    expect(stored()?.status).toBe('DRAFT');
  });
});

describe('PUT /exams/{id}: validating the new questions', () => {
  it.each([
    ['a question under review', [{ number: 1, questionId: 'q3', version: 1, marks: 5 }], 422],
    [
      'a question that does not exist',
      [{ number: 1, questionId: 'nope', version: 1, marks: 5 }],
      422,
    ],
    ['another teacher’s question', [{ number: 1, questionId: 'q5', version: 1, marks: 5 }], 403],
  ])('refuses %s and changes nothing', async (_label, questions, expectedStatus) => {
    const { status } = await call(TEACHER, examRequest({ questions }));

    expect(status).toBe(expectedStatus);
    expect(stored()).toEqual(ready());
  });

  it.each([
    ['zero marks', { questions: [{ number: 1, questionId: 'q1', version: 1, marks: 0 }] }],
    [
      'numbers that skip one',
      { questions: [{ number: 2, questionId: 'q1', version: 1, marks: 5 }] },
    ],
    ['no questions', { questions: [] }],
    ['a bad date', { date: '24-10-2026' }],
  ])('answers 422 for %s', async (_label, change) => {
    expect((await call(TEACHER, { ...examRequest(), ...change })).status).toBe(422);
    expect(stored()).toEqual(ready());
  });

  it('does not look at the questions again when only the title changes', async () => {
    // q1 lost its approval after the exam was made; renaming the exam must still work.
    db.put('Questions', questionItem({ questionId: 'q1', testStatus: undefined }));

    expect((await call(TEACHER, examRequest({ title: 'New title' }))).status).toBe(200);
  });

  it('does look at them when they change', async () => {
    db.put('Questions', questionItem({ questionId: 'q1', testStatus: undefined }));

    const { status } = await call(
      TEACHER,
      examRequest({
        questions: [
          { number: 1, questionId: 'q1', version: 1, marks: 3 },
          { number: 2, questionId: 'q2', version: 1, marks: 5 },
        ],
      }),
    );

    expect(status).toBe(422);
  });

  it('accepts a newer approved version of a question', async () => {
    db.put(
      'Questions',
      questionItem({ questionId: 'q1', version: 2, testStatus: 'APPROVED', signature }),
    );

    const { status } = await call(
      TEACHER,
      examRequest({
        questions: [
          { number: 1, questionId: 'q1', version: 2, marks: 10 },
          { number: 2, questionId: 'q2', version: 1, marks: 5 },
        ],
      }),
    );

    expect(status).toBe(200);
    expect(stored()?.questions[0]).toMatchObject({ questionId: 'q1', version: 2 });
  });
});

describe('PUT /exams/{id}: locked once an answer exists', () => {
  beforeEach(() => answer('s2@college.edu'));

  it('refuses a change to the marks with 409', async () => {
    const { status, body } = await call(
      TEACHER,
      examRequest({
        questions: [
          { number: 1, questionId: 'q1', version: 1, marks: 99 },
          { number: 2, questionId: 'q2', version: 1, marks: 5 },
        ],
      }),
    );

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/locked/);
    expect(stored()).toEqual(ready());
  });

  it('refuses a change to the questions with 409', async () => {
    const { status } = await call(
      TEACHER,
      examRequest({ questions: [{ number: 1, questionId: 'q1', version: 1, marks: 10 }] }),
    );
    expect(status).toBe(409);
    expect(stored()).toEqual(ready());
  });

  it('refuses even when the new questions would be invalid (the lock comes first)', async () => {
    expect(
      (
        await call(
          TEACHER,
          examRequest({ questions: [{ number: 1, questionId: 'q3', version: 1, marks: 5 }] }),
        )
      ).status,
    ).toBe(409);
  });

  it('still lets the title and date change, which sends the exam back to DRAFT', async () => {
    const { status } = await call(
      TEACHER,
      examRequest({ title: 'Corrected title', date: '2026-10-25' }),
    );

    expect(status).toBe(200);
    expect(stored()).toMatchObject({
      title: 'Corrected title',
      date: '2026-10-25',
      status: 'DRAFT',
    });
    expect(stored()?.questions).toEqual(examRequest().questions);
  });

  it('counts an answer that is only queued', async () => {
    db.reset();
    seedExamWorld(db);
    db.put('Exams', examItem());
    answer('s1@college.edu');
    expect(
      (
        await call(
          TEACHER,
          examRequest({
            questions: [
              { number: 1, questionId: 'q1', version: 1, marks: 1 },
              { number: 2, questionId: 'q2', version: 1, marks: 5 },
            ],
          }),
        )
      ).status,
    ).toBe(409);
  });

  it('counts an answer from a student who has left the batch but has an exam row', async () => {
    db.reset();
    seedExamWorld(db);
    db.put('Exams', examItem());
    db.put('ExamStudents', { examId: EXAM_ID, studentEmail: 'moved@college.edu', absent: false });
    answer('moved@college.edu');

    expect(
      (
        await call(
          TEACHER,
          examRequest({
            questions: [
              { number: 1, questionId: 'q1', version: 1, marks: 1 },
              { number: 2, questionId: 'q2', version: 1, marks: 5 },
            ],
          }),
        )
      ).status,
    ).toBe(409);
  });

  it('ignores answers to other exams', async () => {
    db.reset();
    seedExamWorld(db);
    db.put('Exams', examItem());
    db.put('Answers', {
      examStudent: 'other-exam#s1@college.edu',
      questionNumber: 1,
      attempt: 1,
      status: 'QUEUED',
    });

    expect(
      (
        await call(
          TEACHER,
          examRequest({
            questions: [
              { number: 1, questionId: 'q1', version: 1, marks: 1 },
              { number: 2, questionId: 'q2', version: 1, marks: 5 },
            ],
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe('PUT /exams/{id}: other limits', () => {
  it('refuses to edit a published exam with 409', async () => {
    db.put(
      'Exams',
      examItem({
        status: 'PUBLISHED',
        pdfKey: 'exams/exam-1/paper.pdf',
        publishedBy: 'bm@college.edu',
        publishedAt: '2026-10-25T00:00:00.000Z',
      }),
    );

    const { status } = await call(TEACHER, examRequest({ title: 'Too late' }));

    expect(status).toBe(409);
    expect(stored()?.title).toBe('Week 3 test');
    expect(stored()?.status).toBe('PUBLISHED');
  });

  it('does not let the batch change', async () => {
    const { status } = await call('super-admin@college.edu', examRequest({ batchId: 'B' }));

    expect(status).toBe(422);
    expect(stored()?.batchId).toBe('A');
  });

  it('answers 404 for an exam that does not exist', async () => {
    expect((await call(TEACHER, examRequest(), 'nope')).status).toBe(404);
  });
});

describe('PUT /exams/{id}: who may call it', () => {
  it.each(deniedRoles('TEACHER'))('refuses a %s with 403', async (role) => {
    expect(
      (
        await call(
          userOf(role, { batchIds: ['A'], batchId: 'A' }).email,
          examRequest({ title: 'Hijacked' }),
        )
      ).status,
    ).toBe(403);
    expect(stored()).toEqual(ready());
  });

  it('refuses another teacher, even one assigned to the same batch', async () => {
    const { status } = await call(OTHER_TEACHER, examRequest({ title: 'Hijacked' }));

    expect(status).toBe(403);
    expect(stored()).toEqual(ready());
  });

  it('refuses the creator once they are no longer assigned to the batch', async () => {
    db.addUser(userOf('TEACHER', { email: TEACHER, batchIds: ['B'] }));

    expect((await call(TEACHER, examRequest({ title: 'Renamed' }))).status).toBe(403);
    expect(stored()).toEqual(ready());
  });

  it('lets a super admin edit any exam', async () => {
    const { status } = await call('super-admin@college.edu', examRequest({ title: 'By admin' }));

    expect(status).toBe(200);
    expect(stored()?.title).toBe('By admin');
  });
});
