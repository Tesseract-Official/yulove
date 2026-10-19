import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID } from '../test-utils/exams.js';
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
import { handler, IMAGE_LINK_SECONDS } from './get-answer.js';

const db = new FakeDb();
const EMAIL = 's1@college.edu';

const call = (email: string, q: string | number = 1, student = EMAIL, examId = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({
      method: 'GET',
      path: `/answers/${examId}/${student}/${q}`,
      email,
      pathParameters: { examId, studentEmail: student, q: String(q) },
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
  db.put(
    'Answers',
    answerItem(EMAIL, 1, {
      rawTranscription: 'def solve(nums)\n return sum(nums)',
      correctedCode: 'def solve(nums):\n    return sum(nums)',
      fixes: ['Added the missing colon'],
      estimatedComplexity: 'O(n)',
      verdicts: [
        {
          index: 0,
          kind: 'small',
          verdict: 'WA',
          input: '{"nums":[1]}',
          expected: '1',
          actual: '2',
        },
        { index: 7, kind: 'large', verdict: 'TLE' },
      ],
    }),
  );
});

describe('GET /answers/{examId}/{studentEmail}/{q}', () => {
  it('returns the transcription, fixes, language, complexity, verdicts, score and status', async () => {
    const { status, body } = await call(MANAGER);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      examId: EXAM_ID,
      studentEmail: EMAIL,
      questionNumber: 1,
      marks: 10,
      status: 'GRADED',
      attempt: 1,
      language: 'python',
      rawTranscription: 'def solve(nums)\n return sum(nums)',
      correctedCode: 'def solve(nums):\n    return sum(nums)',
      fixes: ['Added the missing colon'],
      estimatedComplexity: 'O(n)',
      meetsComplexity: true,
      testsPassed: 5,
      testsTotal: 10,
      score: 5,
      absent: false,
    });
    expect(body.verdicts).toEqual([
      { index: 0, kind: 'small', verdict: 'WA', input: '{"nums":[1]}', expected: '1', actual: '2' },
      { index: 7, kind: 'large', verdict: 'TLE' },
    ]);
  });

  it('gives a link to the photo that lasts 15 minutes', async () => {
    const { body } = await call(MANAGER);

    expect(body.imageExpiresInSeconds).toBe(900);
    expect(IMAGE_LINK_SECONDS).toBe(900);
    const url = new URL(body.imageUrl);
    expect(url.hostname).toBe('bucket.s3.ap-south-1.amazonaws.com');
    expect(url.pathname).toBe('/answers/exam-1/R1/q1.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('response-content-type')).toBe('image/jpeg');
  });

  it('shows the override and the displayed score', async () => {
    db.put(
      'Answers',
      answerItem(EMAIL, 1, { override: { score: 9, reason: 'Misread', by: 'a@x.com', at: 't' } }),
    );
    const { body } = await call(MANAGER);
    expect(body.score).toBe(9);
    expect(body.override).toMatchObject({ score: 9, reason: 'Misread' });
  });

  it.each([
    ['the teacher who made the exam', TEACHER_A, true],
    ['another teacher of the batch', TEACHER_C, true],
    ['a super admin', 'super-admin@college.edu', true],
    ['a batch manager of the batch', MANAGER, false],
  ])('says whether %s may override: %s', async (_who, email, can) => {
    const { status, body } = await call(email);
    expect(status).toBe(200);
    expect(body.canOverride).toBe(can);
  });

  it('says a teacher taken off the batch can no longer see the answer at all', async () => {
    db.users.get(TEACHER_C)!.batchIds = ['B'];
    expect((await call(TEACHER_C)).status).toBe(403);
  });

  it('shows 0 for an absent student, and says so', async () => {
    db.put('ExamStudents', examStudentRow(EMAIL, { absent: true }));
    const { body } = await call(MANAGER);
    expect(body).toMatchObject({ absent: true, score: 0 });
  });

  it('shows why an answer failed', async () => {
    db.put(
      'Answers',
      answerItem(EMAIL, 2, {
        status: 'FAILED_TO_GRADE',
        failReason: 'UNREADABLE',
        failDetail: 'The page could not be read',
        verdicts: undefined,
        correctedCode: undefined,
        fixes: undefined,
      }),
    );
    const { body } = await call(TEACHER_A, 2);
    expect(body).toMatchObject({
      status: 'FAILED_TO_GRADE',
      failReason: 'UNREADABLE',
      failDetail: 'The page could not be read',
      score: 0,
      fixes: [],
      verdicts: [],
    });
  });

  it('has no photo link for an answer without a photo', async () => {
    db.put('Answers', answerItem(EMAIL, 2, { imageKey: undefined }));
    const { body } = await call(MANAGER, 2);
    expect(body).not.toHaveProperty('imageUrl');
  });

  it('is open to a teacher of the batch and a super admin', async () => {
    expect((await call(TEACHER_A)).status).toBe(200);
    expect((await call('super-admin@college.edu')).status).toBe(200);
  });

  it.each([
    ['a student', 's2@college.edu'],
    ['a batch manager of another batch', MANAGER_B],
    ['a teacher of another batch', TEACHER_B],
  ])('refuses %s with 403', async (_who, email) => {
    expect((await call(email)).status).toBe(403);
  });

  it('answers 404 for an unknown exam, an unknown question, or no answer yet', async () => {
    expect((await call(MANAGER, 1, EMAIL, 'nope')).status).toBe(404);
    expect((await call(MANAGER, 9)).status).toBe(404);
    expect((await call(MANAGER, 2)).status).toBe(404);
    expect((await call(MANAGER, 1, 's2@college.edu')).status).toBe(404);
  });

  it.each(['0', 'abc', '1.5', '-1'])('answers 422 for the question "%s"', async (q) => {
    expect((await call(MANAGER, q)).status).toBe(422);
  });

  it('reads the email in any case', async () => {
    expect((await call(MANAGER, 1, 'S1@College.EDU')).status).toBe(200);
  });
});
