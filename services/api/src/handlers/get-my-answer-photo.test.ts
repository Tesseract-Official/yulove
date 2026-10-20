import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  seedGradingWorld,
  TEACHER_A,
} from '../test-utils/answers.js';
import { handler, STUDENT_PHOTO_LINK_SECONDS } from './get-my-answer-photo.js';

const db = new FakeDb();
const S1 = 's1@college.edu';
const S2 = 's2@college.edu';

const call = (email: string, q: string | number = 1, examId = EXAM_ID, extra = {}) =>
  invoke(
    handler,
    makeEvent({
      method: 'GET',
      path: `/me/exams/${examId}/questions/${q}/photo`,
      email,
      pathParameters: { id: examId, q: String(q) },
      ...extra,
    }),
  );

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['AWS_REGION'] = 'ap-south-1';
  process.env['AWS_ACCESS_KEY_ID'] = 'AKIAFAKEFAKEFAKEFAKE';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'fake-secret';
  delete process.env['AWS_SESSION_TOKEN'];
  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.put('Answers', answerItem(S1, 1, { imageKey: `answers/${EXAM_ID}/R1/q1.jpg` }));
  db.put('Answers', answerItem(S2, 1, { imageKey: `answers/${EXAM_ID}/R2/q1.jpg` }));
});

describe('GET /me/exams/{id}/questions/{q}/photo', () => {
  it('gives a student a link to their own photo that works for 5 minutes', async () => {
    const { status, body } = await call(S1);

    expect(status).toBe(200);
    expect(body.expiresInSeconds).toBe(300);
    expect(STUDENT_PHOTO_LINK_SECONDS).toBe(300);
    const url = new URL(body.url);
    expect(url.hostname).toBe('bucket.s3.ap-south-1.amazonaws.com');
    expect(url.pathname).toBe(`/answers/${EXAM_ID}/R1/q1.jpg`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('image/jpeg');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('is made fresh on every request', async () => {
    const first = (await call(S1)).body.url;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = (await call(S1)).body.url;
    expect(second).not.toBe(first);
  });

  it('only ever gives the caller their own photo, whatever the request names', async () => {
    const mine = await call(S2, 1, EXAM_ID, {
      query: { studentEmail: S1, email: S1, rollNo: 'R1' },
      body: { studentEmail: S1 },
    });
    expect(new URL(mine.body.url).pathname).toBe(`/answers/${EXAM_ID}/R2/q1.jpg`);

    const theirs = await call(S1);
    expect(new URL(theirs.body.url).pathname).toBe(`/answers/${EXAM_ID}/R1/q1.jpg`);
  });

  it('does not put the S3 key or anyone else’s data in the body', async () => {
    const { body } = await call(S1);
    expect(Object.keys(body).sort()).toEqual(['expiresInSeconds', 'url']);
    expect(JSON.stringify({ ...body, url: undefined })).not.toMatch(/answers|R2|s2@/);
  });

  it('follows the latest attempt: the photo now stored for the answer', async () => {
    db.put('Answers', answerItem(S1, 1, { attempt: 2, imageKey: `answers/${EXAM_ID}/R1/q1.jpg` }));
    expect((await call(S1)).status).toBe(200);
  });

  it.each(['READY', 'DRAFT'] as const)(
    'is 403 before the exam is published (%s)',
    async (status) => {
      db.put('Exams', examItem({ status }));
      const result = await call(S1);
      expect(result.status).toBe(403);
      expect(JSON.stringify(result.body)).not.toMatch(/answers|X-Amz/);
    },
  );

  it('is 403 for a student of another batch, and for an exam that does not exist', async () => {
    db.addUser(userOf('STUDENT', { email: 'b@college.edu', batchId: 'B', rollNo: 'R8' }));
    db.put('Answers', answerItem('b@college.edu', 1, { imageKey: `answers/${EXAM_ID}/R8/q1.jpg` }));
    expect((await call('b@college.edu')).status).toBe(403);
    expect((await call(S1, 1, 'no-such-exam')).status).toBe(403);
  });

  it('is 404 when the question has no photo, was never answered, or the student was absent', async () => {
    expect((await call(S1, 2)).status).toBe(404);
    expect((await call(S1, 9)).status).toBe(404);
    const noPhoto = answerItem(S1, 2);
    delete noPhoto.imageKey;
    db.put('Answers', noPhoto);
    expect((await call(S1, 2)).status).toBe(404);
    db.put('ExamStudents', examStudentRow(S1, { absent: true }));
    expect((await call(S1)).status).toBe(404);
  });

  it('is 422 for a question number that is not a number', async () => {
    expect((await call(S1, 'abc')).status).toBe(422);
  });

  it.each([
    ['a batch manager', MANAGER],
    ['a teacher', TEACHER_A],
  ])('is 403 for %s', async (_who, email) => {
    expect((await call(email)).status).toBe(403);
  });

  it('is 403 for a super admin, who is not a student and has no batch', async () => {
    expect((await call('super-admin@college.edu')).status).toBe(403);
  });

  it('is 403 for someone who is not registered, or who has been deactivated', async () => {
    expect((await call('nobody@college.edu')).status).toBe(403);
    db.users.get(S1)!.active = false;
    expect((await call(S1)).status).toBe(403);
  });
});
