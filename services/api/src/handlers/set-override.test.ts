import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AnswerItem, AuditLogItem, ExamStudentItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
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
import { handler as audit } from './get-answer-audit.js';
import { handler as rerun } from './rerun-answer.js';
import { handler } from './set-override.js';

const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);
const ADMIN = 'super-admin@college.edu';
const S1 = 's1@college.edu';

const call = (email: string, payload: unknown, q = 1, student = S1, examId = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({
      method: 'PUT',
      path: `/answers/${examId}/${student}/${q}/override`,
      email,
      pathParameters: { examId, studentEmail: student, q: String(q) },
      body: payload,
    }),
  );
const answer = (n = 1) =>
  db.get<AnswerItem>('Answers', { examStudent: `${EXAM_ID}#${S1}`, questionNumber: n });
const row = () => db.get<ExamStudentItem>('ExamStudents', { examId: EXAM_ID, studentEmail: S1 });
const entries = () =>
  db.all<AuditLogItem>('AuditLog').filter((e) => e.entityKey.startsWith('answer#'));

beforeEach(() => {
  db.reset();
  s3.reset();
  sqs.reset();
  seedGradingWorld(db);
  process.env['BUCKET_NAME'] = 'bucket';
  process.env['TRANSCRIBE_QUEUE_URL'] = 'https://sqs.example/transcribe.fifo';
  s3.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 300_000 });
  sqs.on(SendMessageCommand).resolves({});
  db.put('Answers', answerItem(S1, 1)); // 5 of 10 marks
  db.put('Answers', answerItem(S1, 2)); // 2.5 of 5
});

describe('PUT /answers/{examId}/{studentEmail}/{q}/override', () => {
  it('sets an override with a reason, who and when', async () => {
    const { status, body } = await call(ADMIN, {
      score: 8,
      reason: 'Student explained at the viva',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ score: 8, totalScore: 10.5, maxScore: 15 });
    expect(answer()?.override).toMatchObject({
      score: 8,
      reason: 'Student explained at the viva',
      by: ADMIN,
      byRole: 'SUPER_ADMIN',
    });
    expect(Date.parse(answer()?.override?.at ?? '')).not.toBeNaN();
    expect(answer()?.score).toBe(5); // the formula score is not touched
  });

  it('recomputes the exam total', async () => {
    await call(ADMIN, { score: 10, reason: 'Full marks' });
    expect(row()).toMatchObject({ totalScore: 12.5, maxScore: 15 });
  });

  it('writes the audit entry with the old and new score and the reason', async () => {
    await call(ADMIN, { score: 8, reason: 'Misread by Gemini' });

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      entityKey: `answer#${EXAM_ID}#${S1}#1`,
      actor: ADMIN,
      actorRole: 'SUPER_ADMIN',
      action: 'OVERRIDE_SCORE',
      reason: 'Misread by Gemini',
      before: { override: null, displayedScore: 5 },
      after: { override: 8, displayedScore: 8 },
    });
  });

  it('records the earlier override as the old score when it is changed again', async () => {
    await call(ADMIN, { score: 8, reason: 'First' });
    await call(ADMIN, { score: 6, reason: 'Second look' });

    const second = entries().find((e) => e.reason === 'Second look');
    expect(second).toMatchObject({
      before: { override: 8, displayedScore: 8 },
      after: { override: 6, displayedScore: 6 },
    });
    expect(entries()).toHaveLength(2);
  });

  it('the request itself is also in the audit log, by the wrapper', async () => {
    await call(ADMIN, { score: 8, reason: 'x' });
    const requests = db
      .all<AuditLogItem>('AuditLog')
      .filter((e) => e.entityKey.startsWith('request#'));
    expect(requests[0]).toMatchObject({ actor: ADMIN, method: 'PUT', outcome: 'success' });
    expect(JSON.stringify(requests)).not.toContain('x"'); // no body stored
  });

  it('clears an override with a null score, audited, and the formula score counts again', async () => {
    await call(ADMIN, { score: 9, reason: 'Set' });
    const { status, body } = await call(ADMIN, {
      score: null,
      reason: 'Gemini was right after all',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ score: 5, override: null, totalScore: 7.5 });
    expect(answer()).not.toHaveProperty('override');
    expect(entries().find((e) => e.action === 'CLEAR_OVERRIDE')).toMatchObject({
      before: { override: 9, displayedScore: 9 },
      after: { override: null, displayedScore: 5 },
      reason: 'Gemini was right after all',
    });
  });

  describe("the score must be from 0 to the question's marks", () => {
    it.each([0, 10, 0.01, 9.99, 7.456])('accepts %s', async (score) => {
      expect((await call(ADMIN, { score, reason: 'ok' })).status).toBe(200);
    });

    it.each([-0.01, -1, 10.01, 11, 100])(
      'rejects %s with 422 and changes nothing',
      async (score) => {
        expect((await call(ADMIN, { score, reason: 'no' })).status).toBe(422);
        expect(answer()).not.toHaveProperty('override');
        expect(entries()).toHaveLength(0);
      },
    );

    it('uses the marks of that question', async () => {
      expect((await call(ADMIN, { score: 6, reason: 'q2 has 5 marks' }, 2)).status).toBe(422);
      expect((await call(ADMIN, { score: 5, reason: 'q2' }, 2)).status).toBe(200);
    });

    it('rounds to 2 decimal places', async () => {
      await call(ADMIN, { score: 7.456, reason: 'r' });
      expect(answer()?.override?.score).toBe(7.46);
    });

    it.each([['text'], [null as unknown as number]])('rejects a non-number', async (score) => {
      const result = await call(ADMIN, { score: score === null ? 'x' : score, reason: 'r' });
      expect(result.status).toBe(422);
    });
  });

  it('needs a reason', async () => {
    for (const reason of ['', '   ', undefined]) {
      expect((await call(ADMIN, { score: 5, reason })).status).toBe(422);
    }
    expect((await call(ADMIN, { score: null })).status).toBe(422);
    expect(entries()).toHaveLength(0);
  });

  describe('a student marked absent', () => {
    beforeEach(() => {
      db.put('ExamStudents', examStudentRow(S1, { absent: true }));
    });

    it('is refused with 409, whether setting or clearing, and nothing is written', async () => {
      const set = await call(ADMIN, { score: 8, reason: 'r' });
      expect(set.status).toBe(409);
      expect(set.body.error.message).toBe('Student is marked absent; unmark absent first');
      expect((await call(ADMIN, { score: null, reason: 'r' })).status).toBe(409);
      expect(answer()).not.toHaveProperty('override');
      expect(entries()).toHaveLength(0);
    });

    it('is allowed again once unmarked', async () => {
      db.put('ExamStudents', examStudentRow(S1, { absent: false }));
      expect((await call(ADMIN, { score: 8, reason: 'r' })).status).toBe(200);
    });
  });

  describe('an override survives a re-run', () => {
    it('through the rerun route: the override and its audit trail stay', async () => {
      await call(ADMIN, { score: 9, reason: 'Held at viva' });

      const result = await invoke(
        rerun,
        makeEvent({
          method: 'POST',
          path: '/x',
          email: MANAGER,
          pathParameters: { examId: EXAM_ID, studentEmail: S1, q: '1' },
        }),
      );

      expect(result.status).toBe(200);
      expect(answer()).toMatchObject({
        attempt: 2,
        status: 'QUEUED',
        override: { score: 9, reason: 'Held at viva' },
      });
      expect(entries()).toHaveLength(1);
    });

    it('and still decides the total after the new result is recorded', async () => {
      await call(ADMIN, { score: 9, reason: 'Held at viva' });
      // The Record Lambda's write for attempt 2 leaves the override alone.
      const { recordAnswerResult, recomputeExamTotal } = await import('@yulove/shared/server').then(
        (m) => ({
          recordAnswerResult: m.answersDb.recordAnswerResult,
          recomputeExamTotal: m.recomputeExamTotal,
        }),
      );
      db.put('Answers', { ...answer()!, attempt: 2, status: 'RUNNING' });
      await recordAnswerResult({ examId: EXAM_ID, studentEmail: S1, questionNumber: 1 }, 2, {
        testsPassed: 2,
        testsTotal: 10,
        verdicts: [],
        score: 2,
      });
      const total = await recomputeExamTotal(
        {
          examId: EXAM_ID,
          questions: [
            { number: 1, marks: 10 },
            { number: 2, marks: 5 },
          ],
        },
        S1,
      );

      expect(answer()).toMatchObject({ score: 2, override: { score: 9 } });
      expect(total.totalScore).toBe(11.5);
    });
  });

  describe('who may override', () => {
    it.each([
      ['a student', S1],
      ['a batch manager of the exam’s batch', MANAGER],
      ['a batch manager of another batch', MANAGER_B],
      ['a teacher of the same batch who did not make the exam', TEACHER_C],
      ['a teacher of another batch', TEACHER_B],
    ])('refuses %s with 403, changing nothing', async (_who, email) => {
      expect((await call(email, { score: 8, reason: 'r' })).status).toBe(403);
      expect((await call(email, { score: null, reason: 'r' })).status).toBe(403);
      expect(answer()).not.toHaveProperty('override');
      expect(entries()).toHaveLength(0);
      expect(row()).toBeUndefined(); // no total was worked out
    });

    it('refuses a teacher who made the exam but has since been taken off its batch', async () => {
      db.users.get(TEACHER_A)!.batchIds = ['B'];
      expect((await call(TEACHER_A, { score: 8, reason: 'r' })).status).toBe(403);
      expect(answer()).not.toHaveProperty('override');
    });

    it.each([
      ['the teacher who made the exam', TEACHER_A, 'TEACHER'],
      ['a super admin', ADMIN, 'SUPER_ADMIN'],
    ] as const)('lets %s set and clear an override', async (_who, email, role) => {
      const set = await call(email, { score: 8, reason: 'Viva' });
      expect(set.status).toBe(200);
      expect(answer()?.override).toMatchObject({ score: 8, by: email, byRole: role });

      expect((await call(email, { score: null, reason: 'Undone' })).status).toBe(200);
      expect(answer()).not.toHaveProperty('override');
    });
  });

  describe('a teacher’s override', () => {
    it('still needs a reason, and keeps the 409 for an absent student and the marks limit', async () => {
      expect((await call(TEACHER_A, { score: 8 })).status).toBe(422);
      expect((await call(TEACHER_A, { score: 8, reason: '  ' })).status).toBe(422);
      expect((await call(TEACHER_A, { score: 11, reason: 'r' })).status).toBe(422);
      db.put('ExamStudents', examStudentRow(S1, { absent: true }));
      expect((await call(TEACHER_A, { score: 8, reason: 'r' })).status).toBe(409);
      expect(answer()).not.toHaveProperty('override');
    });

    it('writes an audit entry with who did it and their role, and the usual before and after', async () => {
      await call(TEACHER_A, { score: 7, reason: 'Checked the paper' });

      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toMatchObject({
        entityKey: `answer#${EXAM_ID}#${S1}#1`,
        actor: TEACHER_A,
        actorRole: 'TEACHER',
        action: 'OVERRIDE_SCORE',
        reason: 'Checked the paper',
        before: { override: null, displayedScore: 5 },
        after: { override: 7, displayedScore: 7 },
      });
      // The wrapper only audits super admins' requests: a teacher gets the entry above, not a second one.
      expect(
        db.all<AuditLogItem>('AuditLog').filter((e) => e.entityKey.startsWith('request#')),
      ).toHaveLength(0);
    });

    it('recomputes the total and keeps the formula score, as for a super admin', async () => {
      await call(TEACHER_A, { score: 10, reason: 'Full marks' });
      expect(row()).toMatchObject({ totalScore: 12.5, maxScore: 15 });
      expect(answer()?.score).toBe(5);
    });

    it('keeps the history when a different person overrides it later', async () => {
      await call(TEACHER_A, { score: 8, reason: 'First' });
      await call(ADMIN, { score: 6, reason: 'Second look' });

      expect(entries().map((e) => [e.actor, e.actorRole, e.reason])).toEqual([
        [TEACHER_A, 'TEACHER', 'First'],
        [ADMIN, 'SUPER_ADMIN', 'Second look'],
      ]);
      expect(entries()[1]).toMatchObject({ before: { override: 8 }, after: { override: 6 } });
    });

    it('survives a re-run, like any override', async () => {
      await call(TEACHER_A, { score: 9, reason: 'Held at viva' });
      const result = await invoke(
        rerun,
        makeEvent({
          method: 'POST',
          path: '/x',
          email: MANAGER,
          pathParameters: { examId: EXAM_ID, studentEmail: S1, q: '1' },
        }),
      );
      expect(result.status).toBe(200);
      expect(answer()).toMatchObject({ attempt: 2, override: { score: 9, byRole: 'TEACHER' } });
    });
  });

  it('answers 404 for an unknown exam, question or answer', async () => {
    expect((await call(ADMIN, { score: 1, reason: 'r' }, 1, S1, 'nope')).status).toBe(404);
    expect((await call(ADMIN, { score: 1, reason: 'r' }, 9)).status).toBe(404);
    expect((await call(ADMIN, { score: 1, reason: 'r' }, 1, 's2@college.edu')).status).toBe(404);
  });

  it('is audited for the caller even when it fails', async () => {
    await call(ADMIN, { score: 99, reason: 'too much' });
    const request = db
      .all<AuditLogItem>('AuditLog')
      .find((e) => e.entityKey.startsWith('request#'));
    expect(request).toMatchObject({ outcome: 'rejected', statusCode: 422 });
  });
});

describe('GET /answers/{examId}/{studentEmail}/{q}/audit', () => {
  const history = (email: string, q = 1, student = S1) =>
    invoke(
      audit,
      makeEvent({
        method: 'GET',
        path: `/answers/${EXAM_ID}/${student}/${q}/audit`,
        email,
        pathParameters: { examId: EXAM_ID, studentEmail: student, q: String(q) },
      }),
    );

  it('shows the changes to this answer, newest first', async () => {
    await call(ADMIN, { score: 8, reason: 'First' });
    await call(ADMIN, { score: 6, reason: 'Second' });
    await call(ADMIN, { score: null, reason: 'Third' });
    await call(ADMIN, { score: 4, reason: 'Other question' }, 2);

    const { status, body } = await history(ADMIN);

    expect(status).toBe(200);
    expect(body.entries.map((e: { reason: string }) => e.reason)).toEqual([
      'Third',
      'Second',
      'First',
    ]);
    expect(body.entries[0]).toMatchObject({
      action: 'CLEAR_OVERRIDE',
      actor: ADMIN,
      before: { override: 6 },
      after: { override: null },
    });
    expect(body.entries[2]).toMatchObject({ action: 'OVERRIDE_SCORE', after: { override: 8 } });
  });

  it('names the role of each person who changed the score', async () => {
    await call(TEACHER_A, { score: 8, reason: 'By the teacher' });
    await call(ADMIN, { score: 6, reason: 'By a founder' });

    const { body } = await history(ADMIN);

    expect(
      body.entries.map((e: { actor: string; actorRole: string }) => [e.actor, e.actorRole]),
    ).toEqual([
      [ADMIN, 'SUPER_ADMIN'],
      [TEACHER_A, 'TEACHER'],
    ]);
  });

  it('is empty for an answer nobody changed, and 404 for one that does not exist', async () => {
    expect((await history(ADMIN)).body.entries).toEqual([]);
    expect((await history(ADMIN, 1, 's2@college.edu')).status).toBe(404);
  });

  it.each([
    ['a teacher', TEACHER_A],
    ['a batch manager', MANAGER],
    ['a student', S1],
  ])('is refused to %s with 403', async (_who, email) => {
    await call(ADMIN, { score: 8, reason: 'secret reason' });
    const result = await history(email);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain('secret reason');
  });

  it('is itself recorded when a super admin reads it', async () => {
    await history(ADMIN);
    const request = db
      .all<AuditLogItem>('AuditLog')
      .find((e) => e.entityKey.startsWith('request#') && e.method === 'GET');
    expect(request).toMatchObject({ actor: ADMIN, outcome: 'success' });
  });
});
