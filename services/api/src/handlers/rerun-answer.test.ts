import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { transcribeMsg, type AnswerItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '../test-utils/answers.js';
import { handler } from './rerun-answer.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const EMAIL = 's1@college.edu';
const KEY = 'answers/exam-1/R1/q1.jpg';

const call = (email: string, q: string | number = 1, student = EMAIL, examId = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({
      method: 'POST',
      path: `/answers/${examId}/${student}/${q}/rerun`,
      email,
      pathParameters: { examId, studentEmail: student, q: String(q) },
    }),
  );
const answer = (n = 1) =>
  db.get<AnswerItem>('Answers', { examStudent: `${EXAM_ID}#${EMAIL}`, questionNumber: n });
const sent = () => sqs.commandCalls(SendMessageCommand).map((c) => c.args[0].input);
const notFound = () => Object.assign(new Error('nf'), { name: 'NotFound' });

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  seedGradingWorld(db);
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['TRANSCRIBE_QUEUE_URL'] = 'https://sqs.example/transcribe.fifo';
  s3.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 300_000 });
  sqs.on(SendMessageCommand).resolves({});
  db.put(
    'Answers',
    answerItem(EMAIL, 1, { transcribeTries: 2, score: 3, testsPassed: 3, status: 'GRADED' }),
  );
});

describe('POST /answers/{examId}/{studentEmail}/{q}/rerun', () => {
  it('counts a new attempt, sets QUEUED, clears the busy count and queues a transcription', async () => {
    const { status, body } = await call(MANAGER);

    expect(status).toBe(200);
    expect(body).toMatchObject({ attempt: 2, status: 'QUEUED', questionNumber: 1 });
    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED', imageKey: KEY });
    expect(answer()).not.toHaveProperty('transcribeTries');
  });

  it('sends a TranscribeMsg for the existing photo with the new attempt', async () => {
    await call(MANAGER);

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      QueueUrl: 'https://sqs.example/transcribe.fifo',
      MessageGroupId: 'exam-1#s1@college.edu',
      MessageDeduplicationId: 'exam-1#s1@college.edu#1#2',
    });
    expect(transcribeMsg.parse(JSON.parse(sent()[0]?.MessageBody ?? ''))).toEqual({
      examId: EXAM_ID,
      studentEmail: EMAIL,
      questionNumber: 1,
      attempt: 2,
      questionId: 'q1',
      version: 1,
    });
  });

  it('keeps the earlier score and an override until a new result replaces them', async () => {
    db.put(
      'Answers',
      answerItem(EMAIL, 1, {
        score: 3,
        override: { score: 9, reason: 'r', by: 'a@x.com', at: 't' },
      }),
    );
    await call(MANAGER);
    expect(answer()).toMatchObject({ score: 3, override: { score: 9 } });
  });

  it('uses a photo that was just uploaded (same key) without any other change', async () => {
    await call(MANAGER);
    expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: 'bucket',
      Key: KEY,
    });
    expect(answer()?.imageKey).toBe(KEY);
  });

  it('falls back to the stored photo if nothing is at the current upload key', async () => {
    db.put('Answers', answerItem(EMAIL, 1, { imageKey: 'answers/exam-1/OLD/q1.jpg' }));
    s3.on(HeadObjectCommand, { Key: KEY }).rejects(notFound());

    const { status } = await call(MANAGER);

    expect(status).toBe(200);
    expect(answer()?.imageKey).toBe('answers/exam-1/OLD/q1.jpg');
  });

  it('prefers the current upload key over an older stored one', async () => {
    db.put('Answers', answerItem(EMAIL, 1, { imageKey: 'answers/exam-1/OLD/q1.jpg' }));
    await call(MANAGER);
    expect(answer()?.imageKey).toBe(KEY);
  });

  it('works for a teacher, a super admin, a failed answer and one still in flight', async () => {
    expect((await call(TEACHER_A)).status).toBe(200);
    db.put(
      'Answers',
      answerItem(EMAIL, 1, { status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE' }),
    );
    expect((await call('super-admin@college.edu')).status).toBe(200);
    expect(answer()).not.toHaveProperty('failReason');
    db.put('Answers', answerItem(EMAIL, 1, { status: 'RUNNING' }));
    expect((await call(MANAGER)).status).toBe(200);
    expect(answer()).toMatchObject({ attempt: 2, status: 'QUEUED' });
  });

  it('works for a published exam', async () => {
    db.put('Exams', examItem({ status: 'PUBLISHED' }));
    expect((await call(MANAGER)).status).toBe(200);
  });

  describe('is refused', () => {
    const untouched = () => {
      expect(answer()).toMatchObject({ attempt: 1, status: 'GRADED' });
      expect(sent()).toHaveLength(0);
    };

    it.each([
      ['a student', 's2@college.edu'],
      ['a batch manager of another batch', MANAGER_B],
      ['a teacher of another batch', TEACHER_B],
    ])('for %s with 403', async (_who, email) => {
      expect((await call(email)).status).toBe(403);
      untouched();
    });

    it('for an absent student with 409', async () => {
      db.put('ExamStudents', examStudentRow(EMAIL, { absent: true }));
      const { status, body } = await call(MANAGER);
      expect(status).toBe(409);
      expect(body.error.message).toMatch(/absent/);
      untouched();
    });

    it('for a DRAFT exam with 409', async () => {
      db.put('Exams', examItem({ status: 'DRAFT' }));
      expect((await call(MANAGER)).status).toBe(409);
      untouched();
    });

    it('when there is no answer yet with 404', async () => {
      expect((await call(MANAGER, 2)).status).toBe(404);
      expect(sent()).toHaveLength(0);
    });

    it('when the photo is gone from S3 with 409', async () => {
      s3.on(HeadObjectCommand).rejects(notFound());
      expect((await call(MANAGER)).status).toBe(409);
      untouched();
    });

    it('when the answer has no photo recorded with 409', async () => {
      db.put('Answers', answerItem(EMAIL, 1, { imageKey: undefined }));
      expect((await call(MANAGER)).status).toBe(409);
      expect(sent()).toHaveLength(0);
    });

    it('for an unknown exam (404), question (422) or student (422)', async () => {
      expect((await call(MANAGER, 1, EMAIL, 'nope')).status).toBe(404);
      expect((await call(MANAGER, 9)).status).toBe(422);
      expect((await call(MANAGER, 1, 'other-batch@college.edu')).status).toBe(422);
      expect((await call(MANAGER, 'x')).status).toBe(422);
    });
  });

  describe('when the queue is down', () => {
    it('marks the answer failed and answers 503', async () => {
      sqs.on(SendMessageCommand).rejects(new Error('queue down'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect((await call(MANAGER)).status).toBe(503);
      expect(answer()).toMatchObject({
        attempt: 2,
        status: 'FAILED_TO_GRADE',
        failReason: 'WORKER_ERROR',
        failDetail: 'Could not queue the answer, submit again',
      });
    });
  });
});
