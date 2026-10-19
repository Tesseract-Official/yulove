import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AnswerItem, AppealItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  MANAGER_B,
  seedGradingWorld,
  TEACHER_A,
  TEACHER_B,
  TEACHER_C,
} from '../test-utils/answers.js';
import { handler as createAppeal } from './create-appeal.js';
import { handler as myExam } from './get-my-exam-result.js';
import { handler } from './update-appeal.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const S1 = 's1@college.edu';

const call = (email: string, body: unknown, id = 'ap1') =>
  invoke(
    handler,
    makeEvent({ method: 'PUT', path: `/appeals/${id}`, email, pathParameters: { id }, body }),
  );
const appeal = (id = 'ap1') => db.get<AppealItem>('Appeals', { appealId: id });
const answer = (n = 1) =>
  db.get<AnswerItem>('Answers', { examStudent: `${EXAM_ID}#${S1}`, questionNumber: n });
const sent = () => sqs.commandCalls(SendMessageCommand).map((c) => c.args[0].input);

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  seedGradingWorld(db);
  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.put('Answers', answerItem(S1, 1, { openAppealId: 'ap1', transcribeTries: 1 }));
  db.put('Appeals', {
    appealId: 'ap1',
    examId: EXAM_ID,
    studentEmail: S1,
    questionNumber: 1,
    message: 'Please re-check',
    status: 'OPEN',
    createdAt: '2026-10-20T10:00:00.000Z',
  });
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['TRANSCRIBE_QUEUE_URL'] = 'https://sqs.example/transcribe.fifo';
  s3.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 300_000 });
  sqs.on(SendMessageCommand).resolves({});
});

describe('PUT /appeals/{id}: close', () => {
  it('closes with a note, records who handled it and frees the question for a new appeal', async () => {
    const { status, body } = await call(TEACHER_A, {
      status: 'CLOSED',
      note: 'The marking was right',
    });

    expect(status).toBe(200);
    expect(body.appeal).toMatchObject({
      status: 'CLOSED',
      note: 'The marking was right',
      handledBy: TEACHER_A,
    });
    expect(appeal()).toMatchObject({
      status: 'CLOSED',
      note: 'The marking was right',
      handledBy: TEACHER_A,
    });
    expect(answer()).not.toHaveProperty('openAppealId');
    expect(sent()).toHaveLength(0);
    expect(answer()?.attempt).toBe(1);
  });

  it('needs a note', async () => {
    expect((await call(TEACHER_A, { status: 'CLOSED' })).status).toBe(422);
    expect((await call(TEACHER_A, { status: 'CLOSED', note: '  ' })).status).toBe(422);
    expect(appeal()?.status).toBe('OPEN');
  });

  it('cannot be closed twice, but a RERUN appeal can still be closed', async () => {
    await call(TEACHER_A, { status: 'CLOSED', note: 'Done' });
    const again = await call(TEACHER_A, { status: 'CLOSED', note: 'Again' });
    expect(again.status).toBe(409);
    expect(appeal()?.note).toBe('Done');

    db.put('Appeals', { ...appeal()!, status: 'RERUN' });
    expect((await call(TEACHER_A, { status: 'CLOSED', note: 'Re-graded, fine' })).status).toBe(200);
    expect(appeal()).toMatchObject({ status: 'CLOSED', note: 'Re-graded, fine' });
  });

  it('shows the student the status and the note', async () => {
    await call(TEACHER_A, { status: 'CLOSED', note: 'The marking was right' });
    const { body } = await invoke(
      myExam,
      makeEvent({ method: 'GET', path: '/me/exams/x', email: S1, pathParameters: { id: EXAM_ID } }),
    );
    expect(body.questions[0].appeal).toMatchObject({
      status: 'CLOSED',
      note: 'The marking was right',
    });
    expect(JSON.stringify(body)).not.toContain(TEACHER_A);
  });
});

describe('PUT /appeals/{id}: RERUN', () => {
  it('triggers a new attempt: attempt + 1, QUEUED, a transcription queued, handledBy recorded', async () => {
    const { status, body } = await call(TEACHER_A, {
      status: 'RERUN',
      note: 'Re-grading with a fresh look',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ attempt: 2, appeal: { status: 'RERUN', handledBy: TEACHER_A } });
    expect(appeal()).toMatchObject({
      status: 'RERUN',
      handledBy: TEACHER_A,
      note: 'Re-grading with a fresh look',
    });
    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(answer()).not.toHaveProperty('transcribeTries');
    expect(answer()).not.toHaveProperty('openAppealId');
    expect(sent()).toHaveLength(1);
    expect(JSON.parse(sent()[0]?.MessageBody ?? '')).toMatchObject({
      examId: EXAM_ID,
      studentEmail: S1,
      questionNumber: 1,
      attempt: 2,
    });
  });

  it('works without a note', async () => {
    expect((await call(TEACHER_A, { status: 'RERUN' })).status).toBe(200);
    expect(appeal()).not.toHaveProperty('note');
  });

  it('keeps an override through the re-run', async () => {
    db.put(
      'Answers',
      answerItem(S1, 1, {
        openAppealId: 'ap1',
        override: { score: 9, reason: 'r', by: 'a@x.com', at: 't' },
      }),
    );
    await call(TEACHER_A, { status: 'RERUN' });
    expect(answer()?.override).toMatchObject({ score: 9 });
  });

  it('lets the student appeal again afterwards', async () => {
    await call(TEACHER_A, { status: 'RERUN' });
    const again = await invoke(
      createAppeal,
      makeEvent({
        method: 'POST',
        path: '/appeals',
        email: S1,
        body: { examId: EXAM_ID, questionNumber: 1, message: 'Still wrong' },
      }),
    );
    expect(again.status).toBe(201);
  });

  it('leaves the appeal OPEN when the answer cannot be graded again', async () => {
    db.put('ExamStudents', examStudentRow(S1, { absent: true }));
    expect((await call(TEACHER_A, { status: 'RERUN' })).status).toBe(409);
    expect(appeal()).toMatchObject({ status: 'OPEN' });
    expect(appeal()).not.toHaveProperty('handledBy');
    expect(answer()?.openAppealId).toBe('ap1');

    db.put('ExamStudents', examStudentRow(S1));
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
    expect((await call(TEACHER_A, { status: 'RERUN' })).status).toBe(409);
    expect(appeal()?.status).toBe('OPEN');
    expect(answer()?.attempt).toBe(1);
  });

  it('cannot be asked twice', async () => {
    await call(TEACHER_A, { status: 'RERUN' });
    const second = await call(TEACHER_A, { status: 'RERUN' });
    expect(second.status).toBe(409);
    expect(answer()?.attempt).toBe(2);
    expect(sent()).toHaveLength(1);
  });
});

describe('who may handle an appeal', () => {
  it.each([
    ['a student', S1],
    ['a batch manager of the exam’s batch', MANAGER],
    ['a batch manager of another batch', MANAGER_B],
    ['a teacher of the same batch who did not make the exam', TEACHER_C],
    ['a teacher of another batch', TEACHER_B],
  ])('refuses %s with 403, changing nothing', async (_who, email) => {
    expect((await call(email, { status: 'RERUN' })).status).toBe(403);
    expect((await call(email, { status: 'CLOSED', note: 'x' })).status).toBe(403);
    expect(appeal()?.status).toBe('OPEN');
    expect(answer()?.attempt).toBe(1);
    expect(sent()).toHaveLength(0);
  });

  it.each([
    ['the teacher who made the exam', TEACHER_A],
    ['a super admin', 'super-admin@college.edu'],
  ])('lets %s close an appeal', async (_who, email) => {
    const { status, body } = await call(email, { status: 'CLOSED', note: 'ok' });
    expect(status).toBe(200);
    expect(body.appeal.handledBy).toBe(email);
  });

  it.each([
    ['the teacher who made the exam', TEACHER_A],
    ['a super admin', 'super-admin@college.edu'],
  ])('lets %s send the answer to be graded again', async (_who, email) => {
    const { status, body } = await call(email, { status: 'RERUN' });
    expect(status).toBe(200);
    expect(body.attempt).toBe(2);
    expect(sent()).toHaveLength(1);
  });

  it('answers 404 for an unknown appeal and 422 for a bad body', async () => {
    expect((await call(TEACHER_A, { status: 'CLOSED', note: 'x' }, 'nope')).status).toBe(404);
    expect((await call(TEACHER_A, { status: 'OPEN' })).status).toBe(422);
    expect((await call(TEACHER_A, undefined)).status).toBe(422);
  });
});
