import type { AppealItem } from '@yulove/shared';
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
import { handler } from './get-my-exam-result.js';

const db = new FakeDb();
const S1 = 's1@college.edu';
const call = (email: string, id = EXAM_ID, query?: Record<string, string>) =>
  invoke(
    handler,
    makeEvent({
      method: 'GET',
      path: `/me/exams/${id}`,
      email,
      pathParameters: { id },
      ...(query ? { query } : {}),
    }),
  );

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.addUser(userOf('STUDENT', { email: 's4@college.edu', batchId: 'A', rollNo: 'R4' }));
  db.put(
    'Answers',
    answerItem(S1, 1, {
      testsPassed: 7,
      testsTotal: 10,
      verdicts: [
        { index: 0, kind: 'small', verdict: 'AC' },
        {
          index: 3,
          kind: 'small',
          verdict: 'WA',
          input: '{"nums":[1,2]}',
          expected: '3',
          actual: '4',
        },
        { index: 8, kind: 'large', verdict: 'TLE', input: 'HIDDEN INPUT', expected: 'HIDDEN' },
        { index: 9, kind: 'large', verdict: 'AC' },
      ],
      rawTranscription: 'RAW TRANSCRIPTION',
      correctedCode: 'SECRET CODE',
      driverCode: 'SECRET DRIVER',
      fixes: ['SECRET FIX'],
    }),
  );
  db.put(
    'Answers',
    answerItem(S1, 2, {
      status: 'FAILED_TO_GRADE',
      failReason: 'UNREADABLE',
      failDetail: 'DETAIL',
    }),
  );
  db.put(
    'Answers',
    answerItem('s2@college.edu', 1, { testsPassed: 10, correctedCode: 'OTHER STUDENTS CODE' }),
  );
});

describe('GET /me/exams/{id}', () => {
  it('shows marks scored out of marks available and tests passed out of total', async () => {
    const { status, body } = await call(S1);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      examId: EXAM_ID,
      title: 'Week 3 test',
      absent: false,
      totalScore: 7,
      maxScore: 15,
    });
    expect(body.questions[0]).toMatchObject({
      number: 1,
      marks: 10,
      score: 7,
      status: 'GRADED',
      testsPassed: 7,
      testsTotal: 10,
    });
  });

  it('shows each failed small test with input, expected and their output', async () => {
    const { body } = await call(S1);
    expect(body.questions[0].failedSmallTests).toEqual([
      { index: 3, verdict: 'WA', input: '{"nums":[1,2]}', expected: '3', actual: '4' },
    ]);
  });

  it('shows each failed large test as "Large test N" with its verdict, and nothing else about it', async () => {
    const { body } = await call(S1);
    expect(body.questions[0].failedLargeTests).toEqual([
      { label: 'Large test 2', verdict: 'TLE', message: 'Large test 2: time limit exceeded' },
    ]);
    expect(JSON.stringify(body)).not.toContain('HIDDEN');
  });

  it('says "Could not be graded — raise an appeal" for a question that failed', async () => {
    const { body } = await call(S1);
    expect(body.questions[1]).toMatchObject({
      status: 'FAILED_TO_GRADE',
      messages: ['Could not be graded — raise an appeal'],
      score: 0,
      canAppeal: true,
    });
  });

  it('says the time complexity rule applied, with the required complexity', async () => {
    db.put('Answers', answerItem(S1, 1, { meetsComplexity: false, testsPassed: 10 }));
    const { body } = await call(S1);
    expect(body.questions[0]).toMatchObject({
      score: 0,
      messages: ['Did not meet the required time complexity, O(n)'],
    });
  });

  it('shows Absent across the exam, every score 0', async () => {
    db.put('ExamStudents', examStudentRow(S1, { absent: true }));
    const { body } = await call(S1);

    expect(body).toMatchObject({ absent: true, message: 'Absent', totalScore: 0, maxScore: 15 });
    for (const q of body.questions) {
      expect(q).toMatchObject({ status: 'ABSENT', score: 0, messages: ['Absent'] });
    }
  });

  it('shows a super admin’s override as the score only: no label, no trace', async () => {
    db.put(
      'Answers',
      answerItem(S1, 1, {
        override: {
          score: 9,
          reason: 'PRIVATE REASON',
          by: 'admin@x.com',
          byRole: 'SUPER_ADMIN',
          at: 't',
        },
      }),
    );
    const { body } = await call(S1);

    expect(body.questions[0]).toMatchObject({ score: 9, adjusted: false });
    expect(body.questions[0].messages).toEqual([]);
    expect(body.totalScore).toBe(9);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE REASON|admin|SUPER_ADMIN/i);
  });

  it('says "Score adjusted by teacher" for a teacher’s override, never their email, role or reason', async () => {
    db.put(
      'Answers',
      answerItem(S1, 1, {
        override: {
          score: 9,
          reason: 'PRIVATE REASON',
          by: 'teacher@college.edu',
          byRole: 'TEACHER',
          at: 't',
        },
      }),
    );
    const { body } = await call(S1);

    expect(body.questions[0]).toMatchObject({ score: 9, adjusted: true, adjustedBy: 'teacher' });
    expect(body.questions[0].messages).toContain('Score adjusted by teacher');
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE REASON|teacher@college.edu|TEACHER|"by"/);
  });

  it('reads an override from before roles were recorded as a super admin’s: no label', async () => {
    db.put(
      'Answers',
      answerItem(S1, 1, { override: { score: 9, reason: 'r', by: 'old@x.com', at: 't' } }),
    );
    const { body } = await call(S1);
    expect(body.questions[0]).toMatchObject({ score: 9, adjusted: false });
    expect(body.questions[0].messages).toEqual([]);
  });

  it("shows the appeal status and the reviewer's note, not who handled it", async () => {
    const appeal = (extra: Partial<AppealItem>): AppealItem => ({
      appealId: 'a',
      examId: EXAM_ID,
      studentEmail: S1,
      questionNumber: 1,
      message: 'Please check',
      status: 'OPEN',
      createdAt: '2026-10-20T10:00:00.000Z',
      ...extra,
    });
    db.put(
      'Appeals',
      appeal({
        appealId: 'old',
        status: 'CLOSED',
        createdAt: '2026-10-01T10:00:00Z',
        note: 'Old note',
      }),
    );
    db.put(
      'Appeals',
      appeal({
        appealId: 'new',
        status: 'RERUN',
        note: 'Re-grading',
        handledBy: 'staff@college.edu',
      }),
    );

    const { body } = await call(S1);

    expect(body.questions[0].appeal).toEqual({
      appealId: 'new',
      status: 'RERUN',
      message: 'Please check',
      note: 'Re-grading',
      createdAt: '2026-10-20T10:00:00.000Z',
    });
    expect(body.questions[0].canAppeal).toBe(true);
    expect(JSON.stringify(body)).not.toContain('staff@college.edu');
    expect(body.questions[1]).not.toHaveProperty('appeal');
  });

  it('cannot appeal while an appeal is open', async () => {
    db.put('Appeals', {
      appealId: 'a',
      examId: EXAM_ID,
      studentEmail: S1,
      questionNumber: 1,
      message: 'm',
      status: 'OPEN',
      createdAt: '2026-10-20T10:00:00Z',
    });
    expect((await call(S1)).body.questions[0].canAppeal).toBe(false);
  });

  it('shows questions still being graded, and questions never submitted', async () => {
    db.put('Answers', answerItem(S1, 1, { status: 'RUNNING' }));
    db.put('Answers', { ...answerItem(S1, 2), questionNumber: 3 });
    db.put('Exams', examItem({ status: 'PUBLISHED' }));
    const { body } = await call('s3@college.edu');

    expect(body.questions.map((q: { status: string }) => q.status)).toEqual([
      'NOT_SUBMITTED',
      'NOT_SUBMITTED',
    ]);
    expect((await call(S1)).body.questions[0].status).toBe('IN_PROGRESS');
  });

  it('says which questions have a photo to look at, without saying where it is', async () => {
    const { body } = await call(S1);
    expect(body.questions.map((q: { hasPhoto: boolean }) => q.hasPhoto)).toEqual(
      body.questions.map((_q: unknown, i: number) => i < 2),
    );
  });

  describe('what a student must never get', () => {
    it('no transcription, code, fixes, reasons, image, other students or attempt data anywhere', async () => {
      const { body } = await call(S1);
      const text = JSON.stringify(body);

      for (const secret of [
        'RAW TRANSCRIPTION',
        'SECRET CODE',
        'SECRET DRIVER',
        'SECRET FIX',
        'OTHER STUDENTS CODE',
        'UNREADABLE',
        'DETAIL',
        'answers/',
        'rawTranscription',
        'correctedCode',
        'driverCode',
        'imageKey',
        'fixes',
        's2@college.edu',
        'estimatedComplexity',
        'attempt',
        'testsKey',
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it("cannot read another student's result: it is always the caller's, whatever is asked", async () => {
      const { body } = await call('s2@college.edu', EXAM_ID, { studentEmail: S1, email: S1 });
      expect(body.totalScore).toBe(10);
      expect(body.questions[0].testsPassed).toBe(10);
      expect(JSON.stringify(body)).not.toContain('SECRET');
    });

    it('cannot read an unpublished exam: 404, not "forbidden", and no data', async () => {
      for (const status of ['READY', 'DRAFT'] as const) {
        db.put('Exams', examItem({ status }));
        const result = await call(S1);
        expect(result.status).toBe(404);
        expect(JSON.stringify(result.body)).not.toMatch(/Week 3|score/);
      }
    });

    it('cannot read the exam of another batch, or one that does not exist', async () => {
      db.put('Exams', examItem({ status: 'PUBLISHED', batchId: 'B' }));
      expect((await call(S1)).status).toBe(404);
      expect((await call(S1, 'nope')).status).toBe(404);
    });

    it('cannot be read by staff through the student route', async () => {
      for (const email of [TEACHER_A, MANAGER]) expect((await call(email)).status).toBe(403);
    });
  });
});
