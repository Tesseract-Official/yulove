import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { transcribeMsg, type AnswerItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem, seedExamWorld } from '../test-utils/exams.js';
import { handler } from './submit-answer.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const MANAGER = 'batch-manager@college.edu';
const QUEUE = 'https://sqs.ap-south-1.amazonaws.com/1/transcribe.fifo';
const KEY = 'answers/exam-1/R1/q1.jpg';

const body = (overrides: Record<string, unknown> = {}) => ({
  examId: EXAM_ID,
  studentEmail: 's1@college.edu',
  questionNumber: 1,
  ...overrides,
});

const call = (email: string, payload: unknown = body()) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/answers/submit', email, body: payload }));

const answerOf = (n = 1) =>
  db.get<AnswerItem>('Answers', { examStudent: 'exam-1#s1@college.edu', questionNumber: n });

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  seedExamWorld(db);
  db.put('Exams', examItem({ status: 'READY' }));
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['TRANSCRIBE_QUEUE_URL'] = QUEUE;
  s3.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 400_000 });
  sqs.on(SendMessageCommand).resolves({});
});

describe('POST /answers/submit', () => {
  it('counts attempt 1, sets QUEUED, stores the image key and queues a transcription', async () => {
    const { status, body: out } = await call(MANAGER);

    expect(status).toBe(200);
    expect(out).toMatchObject({ attempt: 1, status: 'QUEUED', questionNumber: 1 });
    expect(answerOf()).toMatchObject({ attempt: 1, status: 'QUEUED', imageKey: KEY });
    expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: 'bucket',
      Key: KEY,
    });
  });

  it('sends a TranscribeMsg with the shared group and deduplication ids', async () => {
    await call(MANAGER);

    const sent = sqs.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      QueueUrl: QUEUE,
      MessageGroupId: 'exam-1#s1@college.edu',
      MessageDeduplicationId: 'exam-1#s1@college.edu#1#1',
    });
    const message = JSON.parse(sent[0]?.MessageBody ?? '');
    expect(transcribeMsg.parse(message)).toEqual({
      examId: 'exam-1',
      studentEmail: 's1@college.edu',
      questionNumber: 1,
      attempt: 1,
      questionId: 'q1',
      version: 1,
    });
  });

  it('uses the exam question for the question id and version', async () => {
    await call(MANAGER, body({ questionNumber: 2 }));
    const message = JSON.parse(
      sqs.commandCalls(SendMessageCommand)[0]?.args[0].input.MessageBody ?? '',
    );
    expect(message).toMatchObject({ questionNumber: 2, questionId: 'q2', version: 1 });
  });

  it('counts a new attempt each time, and a new message id with it', async () => {
    await call(MANAGER);
    await call(MANAGER);

    expect(answerOf()?.attempt).toBe(2);
    const ids = sqs
      .commandCalls(SendMessageCommand)
      .map((c) => c.args[0].input.MessageDeduplicationId);
    expect(ids).toEqual(['exam-1#s1@college.edu#1#1', 'exam-1#s1@college.edu#1#2']);
  });

  it('clears an earlier failure when it is submitted again', async () => {
    db.put('Answers', {
      examStudent: 'exam-1#s1@college.edu',
      questionNumber: 1,
      attempt: 1,
      status: 'FAILED_TO_GRADE',
      failReason: 'UNREADABLE',
      failDetail: 'blurry',
    });
    await call(MANAGER);
    const answer = answerOf();
    expect(answer).toMatchObject({ attempt: 2, status: 'QUEUED' });
    expect(answer).not.toHaveProperty('failReason');
    expect(answer).not.toHaveProperty('failDetail');
  });

  it('works for a published exam and for a super admin', async () => {
    db.put('Exams', examItem({ status: 'PUBLISHED' }));
    expect((await call('super-admin@college.edu')).status).toBe(200);
  });

  describe('when the photo is not right', () => {
    it('answers 409 and changes nothing if the photo was never uploaded', async () => {
      s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
      const { status, body: out } = await call(MANAGER);

      expect(status).toBe(409);
      expect(out.error.message).toMatch(/Upload it first/);
      expect(answerOf()).toBeUndefined();
      expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it.each([
      ['not a JPEG', { ContentType: 'image/png', ContentLength: 1000 }],
      ['empty', { ContentType: 'image/jpeg', ContentLength: 0 }],
      ['over 5 MB', { ContentType: 'image/jpeg', ContentLength: 5 * 1024 * 1024 + 1 }],
    ])('answers 409 if it is %s', async (_name, head) => {
      s3.on(HeadObjectCommand).resolves(head);
      expect((await call(MANAGER)).status).toBe(409);
      expect(answerOf()).toBeUndefined();
      expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it('does not hide other S3 errors as a missing photo', async () => {
      s3.on(HeadObjectCommand).rejects(Object.assign(new Error('denied'), { name: 'Forbidden' }));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await call(MANAGER)).status).toBe(500);
    });
  });

  describe('when the queue is down', () => {
    it('marks the answer failed, tells the caller, and does not leave it QUEUED', async () => {
      sqs.on(SendMessageCommand).rejects(new Error('queue down'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { status } = await call(MANAGER);

      expect(status).toBe(503);
      expect(answerOf()).toMatchObject({
        attempt: 1,
        status: 'FAILED_TO_GRADE',
        failReason: 'WORKER_ERROR',
        failDetail: 'Could not queue the answer, submit again',
      });
    });

    it('counts one FailedToGrade metric for it, and one AppError for the 503', async () => {
      sqs.on(SendMessageCommand).rejects(new Error('queue down'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await call(MANAGER);

      const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
      expect(lines.filter((l) => l['FailedToGrade'] === 1)).toEqual([
        expect.objectContaining({ reason: 'WORKER_ERROR' }),
      ]);
      expect(lines.filter((l) => l['AppError'] === 1)).toHaveLength(1);
      log.mockRestore();
    });
  });

  describe('is refused', () => {
    it.each(deniedRoles('BATCH_MANAGER'))('for a %s with 403', async (role) => {
      const { status } = await call(userOf(role, { batchIds: ['A'], batchId: 'A' }).email);
      expect(status).toBe(403);
      expect(answerOf()).toBeUndefined();
    });

    it('for a batch manager of another batch with 403', async () => {
      db.addUser(userOf('BATCH_MANAGER', { email: 'bm-b@college.edu', batchIds: ['B'] }));
      expect((await call('bm-b@college.edu')).status).toBe(403);
      expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(0);
    });

    it('for an absent student with 409, without counting an attempt', async () => {
      db.put('ExamStudents', { examId: EXAM_ID, studentEmail: 's1@college.edu', absent: true });
      expect((await call(MANAGER)).status).toBe(409);
      expect(answerOf()).toBeUndefined();
      expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it('for a DRAFT exam with 409', async () => {
      db.put('Exams', examItem({ status: 'DRAFT' }));
      expect((await call(MANAGER)).status).toBe(409);
      expect(answerOf()).toBeUndefined();
    });

    it('for a student of another batch, an inactive student or a bad question with 422', async () => {
      expect((await call(MANAGER, body({ studentEmail: 'other-batch@college.edu' }))).status).toBe(
        422,
      );
      expect((await call(MANAGER, body({ studentEmail: 'inactive@college.edu' }))).status).toBe(
        422,
      );
      expect((await call(MANAGER, body({ questionNumber: 9 }))).status).toBe(422);
    });

    it('for an unknown exam with 404, and an invalid body with 422', async () => {
      expect((await call(MANAGER, body({ examId: 'nope' }))).status).toBe(404);
      expect((await call(MANAGER, { examId: EXAM_ID })).status).toBe(422);
      expect(
        (
          await invoke(
            handler,
            makeEvent({ method: 'POST', path: '/answers/submit', email: MANAGER }),
          )
        ).status,
      ).toBe(422);
    });
  });
});
