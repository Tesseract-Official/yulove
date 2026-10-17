import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ExamItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem, seedExamWorld } from '../test-utils/exams.js';
import { OTHER_TEACHER, TEACHER, questionItem } from '../test-utils/questions.js';
import { handler } from './generate-exam-pdf.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);

const call = (email: string, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({ method: 'POST', path: `/exams/${id}/pdf`, email, pathParameters: { id } }),
  );

const stored = () => db.get<ExamItem>('Exams', { examId: EXAM_ID });
const puts = () => s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input);

beforeEach(() => {
  db.reset();
  s3.reset();
  s3.on(PutObjectCommand).resolves({});
  process.env['BUCKET_NAME'] = 'bucket';
  seedExamWorld(db);
  db.put('Exams', examItem());
});

describe('POST /exams/{id}/pdf', () => {
  it('renders the paper, stores it, and marks the exam READY', async () => {
    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(body).toEqual({
      examId: EXAM_ID,
      status: 'READY',
      pdfKey: 'exams/exam-1/paper.pdf',
      pageCount: 2,
    });
    expect(stored()).toMatchObject({ status: 'READY', pdfKey: 'exams/exam-1/paper.pdf' });

    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({
      Bucket: 'bucket',
      Key: 'exams/exam-1/paper.pdf',
      ContentType: 'application/pdf',
    });
    const file = puts()[0]?.Body as Buffer;
    expect(file.subarray(0, 5).toString()).toBe('%PDF-');
    expect(file.length).toBeGreaterThan(5_000);
  });

  it('has one page per question', async () => {
    db.put(
      'Exams',
      examItem({ questions: [{ number: 1, questionId: 'q1', version: 1, marks: 10 }] }),
    );
    expect((await call(TEACHER)).body.pageCount).toBe(1);
  });

  it('regenerates a READY exam and keeps it READY', async () => {
    db.put('Exams', examItem({ status: 'READY', pdfKey: 'exams/exam-1/paper.pdf' }));

    const { body } = await call(TEACHER);

    expect(body.status).toBe('READY');
    expect(puts()).toHaveLength(1);
  });

  it('lets a published exam be printed again without un-publishing it', async () => {
    db.put(
      'Exams',
      examItem({
        status: 'PUBLISHED',
        pdfKey: 'exams/exam-1/paper.pdf',
        publishedBy: 'bm@college.edu',
      }),
    );

    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(body.status).toBe('PUBLISHED');
    expect(stored()?.status).toBe('PUBLISHED');
    expect(stored()?.publishedBy).toBe('bm@college.edu');
  });

  it('works for an exam whose batch has no name record', async () => {
    db.put('Exams', examItem({ batchId: 'A' }));
    expect((await call(TEACHER)).status).toBe(200);
  });
});

describe('POST /exams/{id}/pdf: questions that are no longer usable', () => {
  it('refuses with 409 when a question lost its approval, and changes nothing', async () => {
    // Editing a question's statement clears its tests and status.
    db.put(
      'Questions',
      questionItem({ questionId: 'q1', title: 'Two Sum', testStatus: undefined }),
    );

    const { status, body } = await call(TEACHER);

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/q1 v1/);
    expect(puts()).toHaveLength(0);
    expect(stored()?.status).toBe('DRAFT');
    expect(stored()).not.toHaveProperty('pdfKey');
  });

  it('refuses with 409 when a question version is gone', async () => {
    db.put(
      'Exams',
      examItem({ questions: [{ number: 1, questionId: 'q1', version: 9, marks: 5 }] }),
    );

    expect((await call(TEACHER)).status).toBe(409);
    expect(puts()).toHaveLength(0);
  });

  it('refuses with 409 when the exam is edited while the PDF is being made', async () => {
    s3.on(PutObjectCommand).callsFake(() => {
      db.put('Exams', examItem({ title: 'Edited meanwhile' }));
      return {};
    });

    const { status, body } = await call(TEACHER);

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/changed/);
    expect(stored()?.status).toBe('DRAFT');
    expect(stored()?.title).toBe('Edited meanwhile');
  });

  it('leaves the exam alone when storing the file fails', async () => {
    s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));

    expect((await call(TEACHER)).status).toBe(500);
    expect(stored()?.status).toBe('DRAFT');
    expect(stored()).not.toHaveProperty('pdfKey');
  });
});

describe('POST /exams/{id}/pdf: who may call it', () => {
  it.each(deniedRoles('TEACHER'))('refuses a %s with 403 and writes nothing', async (role) => {
    expect((await call(userOf(role, { batchIds: ['A'], batchId: 'A' }).email)).status).toBe(403);
    expect(puts()).toHaveLength(0);
  });

  it('refuses another teacher with 403', async () => {
    expect((await call(OTHER_TEACHER)).status).toBe(403);
    expect(puts()).toHaveLength(0);
    expect(stored()?.status).toBe('DRAFT');
  });

  it('refuses the creator once they lose the batch', async () => {
    db.addUser(userOf('TEACHER', { email: TEACHER, batchIds: [] }));
    expect((await call(TEACHER)).status).toBe(403);
  });

  it('lets a super admin generate any exam’s paper', async () => {
    const { status } = await call('super-admin@college.edu');
    expect(status).toBe(200);
    expect(stored()?.status).toBe('READY');
  });

  it('answers 404 for an exam that does not exist', async () => {
    expect((await call(TEACHER, 'nope')).status).toBe(404);
  });
});
