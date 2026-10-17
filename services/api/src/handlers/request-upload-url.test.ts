import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem, seedExamWorld } from '../test-utils/exams.js';
import { handler } from './request-upload-url.js';

const db = new FakeDb();
const MANAGER = 'batch-manager@college.edu';

const body = (overrides: Record<string, unknown> = {}) => ({
  examId: EXAM_ID,
  studentEmail: 's1@college.edu',
  questionNumber: 1,
  contentType: 'image/jpeg',
  ...overrides,
});

const call = (email: string, payload: unknown = body()) =>
  invoke(handler, makeEvent({ method: 'POST', path: '/answers/upload-url', email, body: payload }));

/** The signed policy inside a presigned POST. */
function policyOf(fields: Record<string, string>) {
  return JSON.parse(Buffer.from(fields['Policy'] as string, 'base64').toString('utf8')) as {
    expiration: string;
    conditions: unknown[];
  };
}

beforeEach(() => {
  db.reset();
  seedExamWorld(db);
  db.put('Exams', examItem({ status: 'READY' }));
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['AWS_REGION'] = 'ap-south-1';
  process.env['AWS_ACCESS_KEY_ID'] = 'AKIAFAKEFAKEFAKEFAKE';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'fake-secret';
  delete process.env['AWS_SESSION_TOKEN'];
});

describe('POST /answers/upload-url', () => {
  it('returns a presigned POST for the answer photo', async () => {
    const before = Date.now();
    const { status, body: out } = await call(MANAGER);

    expect(status).toBe(200);
    expect(out.key).toBe('answers/exam-1/R1/q1.jpg');
    expect(out.expiresInSeconds).toBe(600);
    expect(out.maxBytes).toBe(5 * 1024 * 1024);
    expect(new URL(out.url).hostname).toBe('bucket.s3.ap-south-1.amazonaws.com');
    expect(out.fields['key']).toBe('answers/exam-1/R1/q1.jpg');
    expect(out.fields['Content-Type']).toBe('image/jpeg');
    expect(out.fields['X-Amz-Signature']).toMatch(/^[0-9a-f]{64}$/);

    const policy = policyOf(out.fields);
    const lifetime = Date.parse(policy.expiration) - before;
    expect(lifetime).toBeGreaterThan(9 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000 + 2000);
  });

  it('limits the upload to JPEG, 1 byte to 5 MB, and exactly that key', async () => {
    const { body: out } = await call(MANAGER);
    const { conditions } = policyOf(out.fields);

    expect(conditions).toContainEqual(['eq', '$Content-Type', 'image/jpeg']);
    expect(conditions).toContainEqual(['content-length-range', 1, 5 * 1024 * 1024]);
    expect(conditions).toContainEqual({ bucket: 'bucket' });
    expect(conditions).toContainEqual({ key: 'answers/exam-1/R1/q1.jpg' });
  });

  it('works for a published exam and the second question', async () => {
    db.put('Exams', examItem({ status: 'PUBLISHED' }));
    const { status, body: out } = await call(MANAGER, body({ questionNumber: 2 }));
    expect(status).toBe(200);
    expect(out.key).toBe('answers/exam-1/R1/q2.jpg');
  });

  it('lets a super admin ask for any batch', async () => {
    expect((await call('super-admin@college.edu')).status).toBe(200);
  });

  it('writes the student a row on first use if they were imported after the exam', async () => {
    expect(db.all('ExamStudents')).toHaveLength(0);
    await call(MANAGER);
    expect(db.get('ExamStudents', { examId: EXAM_ID, studentEmail: 's1@college.edu' })).toEqual({
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      absent: false,
    });
  });

  describe('is refused', () => {
    it.each(deniedRoles('BATCH_MANAGER'))('for a %s with 403', async (role) => {
      const { status } = await call(userOf(role, { batchIds: ['A'], batchId: 'A' }).email);
      expect(status).toBe(403);
    });

    it('for a batch manager of another batch with 403', async () => {
      db.addUser(userOf('BATCH_MANAGER', { email: 'bm-b@college.edu', batchIds: ['B'] }));
      expect((await call('bm-b@college.edu')).status).toBe(403);
    });

    it('for a student who is marked absent with 409', async () => {
      db.put('ExamStudents', { examId: EXAM_ID, studentEmail: 's1@college.edu', absent: true });
      const { status, body: out } = await call(MANAGER);
      expect(status).toBe(409);
      expect(out.error.message).toMatch(/absent/);
    });

    it.each(['DRAFT'] as const)('for a %s exam with 409', async (examStatus) => {
      db.put('Exams', examItem({ status: examStatus }));
      const { status, body: out } = await call(MANAGER);
      expect(status).toBe(409);
      expect(out.error.message).toMatch(/not ready/);
    });

    it('for a student of another batch with 422', async () => {
      expect((await call(MANAGER, body({ studentEmail: 'other-batch@college.edu' }))).status).toBe(
        422,
      );
    });

    it('for an inactive student with 422', async () => {
      expect((await call(MANAGER, body({ studentEmail: 'inactive@college.edu' }))).status).toBe(
        422,
      );
    });

    it('for someone who is not a student with 422', async () => {
      expect((await call(MANAGER, body({ studentEmail: 'teacher@college.edu' }))).status).toBe(422);
      expect((await call(MANAGER, body({ studentEmail: 'nobody@college.edu' }))).status).toBe(422);
    });

    it('for a question number the exam does not have with 422', async () => {
      expect((await call(MANAGER, body({ questionNumber: 3 }))).status).toBe(422);
    });

    it('for an unknown exam with 404', async () => {
      expect((await call(MANAGER, body({ examId: 'nope' }))).status).toBe(404);
    });

    it.each([
      ['a type other than JPEG', { contentType: 'image/png' }],
      ['no content type', { contentType: undefined }],
      ['question number 0', { questionNumber: 0 }],
      ['a fractional question number', { questionNumber: 1.5 }],
      ['no exam id', { examId: undefined }],
    ])('for %s with 422', async (_name, overrides) => {
      expect((await call(MANAGER, body(overrides))).status).toBe(422);
    });

    it('for a missing body with 422', async () => {
      expect(
        (
          await invoke(
            handler,
            makeEvent({ method: 'POST', path: '/answers/upload-url', email: MANAGER }),
          )
        ).status,
      ).toBe(422);
    });
  });
});
