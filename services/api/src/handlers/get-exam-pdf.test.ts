import type { ExamItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem, seedExamWorld } from '../test-utils/exams.js';
import { OTHER_TEACHER, TEACHER } from '../test-utils/questions.js';
import { downloadName, handler, LINK_SECONDS } from './get-exam-pdf.js';

const db = new FakeDb();
const call = (email: string, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({ method: 'GET', path: `/exams/${id}/pdf`, email, pathParameters: { id } }),
  );

const withPdf = (overrides: Partial<ExamItem> = {}) =>
  examItem({ status: 'READY', pdfKey: 'exams/exam-1/paper.pdf', ...overrides });

beforeEach(() => {
  db.reset();
  seedExamWorld(db);
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['AWS_REGION'] = 'ap-south-1';
  process.env['AWS_ACCESS_KEY_ID'] = 'AKIAFAKEFAKEFAKEFAKE';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'fake-secret';
  delete process.env['AWS_SESSION_TOKEN'];
  db.put('Exams', withPdf());
});

describe('GET /exams/{id}/pdf', () => {
  it('returns a download link that lasts 15 minutes', async () => {
    const { status, body } = await call(TEACHER);

    expect(status).toBe(200);
    expect(body.expiresInSeconds).toBe(900);
    expect(LINK_SECONDS).toBe(900);

    const url = new URL(body.url);
    expect(url.hostname).toBe('bucket.s3.ap-south-1.amazonaws.com');
    expect(url.pathname).toBe('/exams/exam-1/paper.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('asks the browser to download a PDF with a readable name', async () => {
    const { body } = await call(TEACHER);

    const url = new URL(body.url);
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="week-3-test-2026-10-24.pdf"',
    );
    expect(body.filename).toBe('week-3-test-2026-10-24.pdf');
  });

  it('works for a published exam', async () => {
    db.put('Exams', withPdf({ status: 'PUBLISHED' }));
    expect((await call(TEACHER)).status).toBe(200);
  });

  it.each([
    ['a DRAFT exam', examItem()],
    [
      'a DRAFT exam that still has an old file name',
      examItem({ pdfKey: 'exams/exam-1/paper.pdf' }),
    ],
    ['a READY exam without a file', examItem({ status: 'READY' })],
  ])('answers 409 for %s', async (_label, exam) => {
    db.put('Exams', exam);

    const { status, body } = await call(TEACHER);

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/Generate it first/);
    expect(body).not.toHaveProperty('url');
  });

  it('answers 404 for an exam that does not exist', async () => {
    expect((await call(TEACHER, 'nope')).status).toBe(404);
  });
});

describe('GET /exams/{id}/pdf: who may call it', () => {
  const MANAGER_A = 'batch-manager@college.edu';
  const addStaff = (role: 'TEACHER' | 'BATCH_MANAGER', email: string, batchIds: string[]) =>
    db.addUser(userOf(role, { email, batchIds }));

  it('lets the exam’s creator download it', async () => {
    expect((await call(TEACHER)).status).toBe(200);
  });

  it('lets another teacher assigned to the exam’s batch download it', async () => {
    const { status, body } = await call(OTHER_TEACHER);

    expect(status).toBe(200);
    expect(new URL(body.url).pathname).toBe('/exams/exam-1/paper.pdf');
  });

  it('lets a batch manager assigned to the exam’s batch download it', async () => {
    expect((await call(MANAGER_A)).status).toBe(200);
  });

  it('lets a super admin download any exam’s paper', async () => {
    expect((await call('super-admin@college.edu')).status).toBe(200);
  });

  it.each([
    ['a teacher', 'TEACHER'],
    ['a batch manager', 'BATCH_MANAGER'],
  ] as const)(
    'refuses %s who is only assigned to another batch, and gives no link',
    async (_who, role) => {
      addStaff(role, 'elsewhere@college.edu', ['B']);

      const { status, body } = await call('elsewhere@college.edu');

      expect(status).toBe(403);
      expect(JSON.stringify(body)).not.toContain('X-Amz');
    },
  );

  it('refuses a teacher or batch manager with no batches', async () => {
    addStaff('TEACHER', 'nobatch@college.edu', []);
    addStaff('BATCH_MANAGER', 'nobatch2@college.edu', []);

    expect((await call('nobatch@college.edu')).status).toBe(403);
    expect((await call('nobatch2@college.edu')).status).toBe(403);
  });

  it('refuses the creator once they lose the batch', async () => {
    db.addUser(userOf('TEACHER', { email: TEACHER, batchIds: ['B'] }));
    expect((await call(TEACHER)).status).toBe(403);
  });

  it('refuses a student, even of the same batch, and gives no link', async () => {
    const { status, body } = await call('s1@college.edu');

    expect(status).toBe(403);
    expect(JSON.stringify(body)).not.toContain('X-Amz');
  });

  it('answers 401 without an email claim', async () => {
    const response = await invoke(
      handler,
      makeEvent({ method: 'GET', path: '/exams/exam-1/pdf', pathParameters: { id: EXAM_ID } }),
    );
    expect(response.status).toBe(401);
  });
});

describe('downloadName', () => {
  it.each([
    ['Week 3 test', '2026-10-24', 'week-3-test-2026-10-24.pdf'],
    ['  DSA: Mid-Term (Batch A)!  ', '2026-11-02', 'dsa-mid-term-batch-a-2026-11-02.pdf'],
    ['Café ≤ 100', '2026-01-01', 'cafe-100-2026-01-01.pdf'],
    ['!!!', '2026-01-01', 'exam-2026-01-01.pdf'],
    ['"; rm -rf /', '2026-01-01', 'rm-rf-2026-01-01.pdf'],
  ])('%j -> %s', (title, date, expected) => {
    expect(downloadName(title, date)).toBe(expected);
  });

  it('is cut to a sensible length and never has quotes or slashes', () => {
    const name = downloadName('x'.repeat(500), '2026-01-01');
    expect(name.length).toBeLessThanOrEqual(75);
    expect(name).toMatch(/^[a-z0-9-]+\.pdf$/);
  });
});
