import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Role } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiEvent } from '../lib/http.js';
import { invoke, makeEvent, userOf } from '../test-utils/events.js';
import { EXAM_ID, examItem, examRequest } from '../test-utils/exams.js';
import {
  answerItem,
  MANAGER,
  seedGradingWorld,
  TEACHER_A,
  TEACHER_C,
} from '../test-utils/answers.js';
import { handler as createExam } from './create-exam.js';
import { handler as getAnswer } from './get-answer.js';
import { handler as getAudit } from './get-answer-audit.js';
import { handler as getBoard } from './get-exam-board.js';
import { handler as getExam } from './get-exam.js';
import { handler as getResults } from './get-exam-results.js';
import { handler as getMyExam } from './get-my-exam-result.js';
import { handler as getMyExams } from './get-my-exams.js';
import { handler as getPhoto } from './get-my-answer-photo.js';
import { handler as listAppeals } from './list-appeals.js';
import { handler as listExams } from './list-exams.js';
import { handler as publishExam } from './publish-exam.js';
import { handler as setActive } from './set-user-active.js';
import { handler as setOverride } from './set-override.js';
import { handler as updateAppeal } from './update-appeal.js';

/**
 * Everything a super admin does is applied and audited, but leaves no trace in what teachers,
 * batch managers and students are sent. Each test performs the actions through the real handlers,
 * then reads every endpoint a role can use and looks for the super admin in the raw responses.
 */
const db = new FakeDb();
const s3 = mockClient(S3Client);
const sqs = mockClient(SQSClient);

const FOUNDER = 'founder-zed@gmail.com';
const S1 = 's1@college.edu';
const S3_ = 's3@college.edu';
const SECRET_REASON = 'Founder private reason';
/** What a super admin writes in a closing note is the outcome, so everyone concerned still sees it. */
const CLOSING_NOTE = 'Checked again and the marks stand';
const EXAM_2 = 'exam-2';

type Params = Record<string, string>;
const send = (
  handler: (event: ApiEvent) => Promise<unknown>,
  method: string,
  path: string,
  email: string,
  pathParameters?: Params,
  extra: { query?: Record<string, string>; body?: unknown } = {},
) =>
  invoke(
    handler as never,
    makeEvent({ method, path, email, ...(pathParameters ? { pathParameters } : {}), ...extra }),
  );

type Read = () => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const answerParams = { examId: EXAM_ID, studentEmail: S1, q: '1' };
const answerPath = `/answers/${EXAM_ID}/${S1}/1`;

const commonReads = (email: string) => ({
  listExams: () => send(listExams, 'GET', '/exams', email),
  board: () => send(getBoard, 'GET', `/exams/${EXAM_ID}/answers`, email, { id: EXAM_ID }),
  answer: () => send(getAnswer, 'GET', answerPath, email, answerParams),
  answer2: () =>
    send(getAnswer, 'GET', `/answers/${EXAM_ID}/${S1}/2`, email, { ...answerParams, q: '2' }),
});

/** Every read endpoint a teacher can use. */
const teacherReads = (email: string) => ({
  ...commonReads(email),
  audit: () => send(getAudit, 'GET', `${answerPath}/audit`, email, answerParams),
  appeals: () =>
    send(listAppeals, 'GET', '/appeals', email, undefined, { query: { examId: EXAM_ID } }),
  results: () => send(getResults, 'GET', `/exams/${EXAM_ID}/results`, email, { id: EXAM_ID }),
  exam1: () => send(getExam, 'GET', `/exams/${EXAM_ID}`, email, { id: EXAM_ID }),
  exam2: () => send(getExam, 'GET', `/exams/${EXAM_2}`, email, { id: EXAM_2 }),
});

/** Every read endpoint a batch manager can use (publishing again only reads when it is done). */
const managerReads = (email: string) => ({
  ...commonReads(email),
  publishAgain: () => send(publishExam, 'POST', `/exams/${EXAM_2}/publish`, email, { id: EXAM_2 }),
});

/** Every endpoint a student can use. */
const studentReads = (email: string) => ({
  myExams: () => send(getMyExams, 'GET', '/me/exams', email),
  myExam: () => send(getMyExam, 'GET', `/me/exams/${EXAM_ID}`, email, { id: EXAM_ID }),
  photo: () =>
    send(getPhoto, 'GET', `/me/exams/${EXAM_ID}/questions/1/photo`, email, { id: EXAM_ID, q: '1' }),
});

const readsOf = (
  role: 'TEACHER' | 'BATCH_MANAGER' | 'STUDENT',
  email: string,
): Record<string, Read> =>
  role === 'TEACHER'
    ? teacherReads(email)
    : role === 'BATCH_MANAGER'
      ? managerReads(email)
      : studentReads(email);

/** What gives a super admin away in a response, in any field. */
const TRACES = [
  /founder/i,
  /SUPER_ADMIN/,
  /super[ _-]?admin/i,
  /\badmin\b/i,
  new RegExp(SECRET_REASON, 'i'),
];

beforeEach(async () => {
  db.reset();
  s3.reset();
  sqs.reset();
  seedGradingWorld(db);
  db.addUser(userOf('SUPER_ADMIN', { email: FOUNDER, name: 'Founder Zed' }));
  db.addUser(userOf('STUDENT', { email: S3_, batchId: 'A', rollNo: 'R3' }));
  Object.assign(process.env, {
    BUCKET_NAME: 'bucket',
    AWS_REGION: 'ap-south-1',
    AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret',
    TRANSCRIBE_QUEUE_URL: 'https://sqs.example/transcribe.fifo',
  });
  delete process.env['AWS_SESSION_TOKEN'];
  s3.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg', ContentLength: 300_000 });
  sqs.on(SendMessageCommand).resolves({});

  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.put('Answers', answerItem(S1, 1, { openAppealId: 'ap1' }));
  db.put('Answers', answerItem(S1, 2, { openAppealId: 'ap2' }));
  for (const [appealId, questionNumber] of [
    ['ap1', 1],
    ['ap2', 2],
  ] as const) {
    db.put('Appeals', {
      appealId,
      examId: EXAM_ID,
      studentEmail: S1,
      questionNumber,
      reason: 'WRONG_MARKS',
      message: 'Please re-check',
      status: 'OPEN',
      createdAt: '2026-10-20T10:00:00.000Z',
    });
  }
});

/** The super admin acts: override, re-grade an appeal, close another, make and publish an exam, deactivate. */
async function superAdminActs() {
  const results = [
    await send(
      setOverride,
      'PUT',
      `/answers/${EXAM_ID}/${S1}/1/override`,
      FOUNDER,
      {
        examId: EXAM_ID,
        studentEmail: S1,
        q: '1',
      },
      { body: { score: 9, reason: SECRET_REASON } },
    ),
    await send(
      updateAppeal,
      'PUT',
      '/appeals/ap1',
      FOUNDER,
      { id: 'ap1' },
      { body: { status: 'RERUN' } },
    ),
    await send(
      updateAppeal,
      'PUT',
      '/appeals/ap2',
      FOUNDER,
      { id: 'ap2' },
      {
        body: { status: 'CLOSED', note: CLOSING_NOTE },
      },
    ),
    await send(createExam, 'POST', '/exams', FOUNDER, undefined, {
      body: examRequest({ title: 'Second exam' }),
    }),
  ];
  // The exam the founder made is published by the founder too.
  const made = (results[3] as { body: { exam: { examId: string } } }).body.exam.examId;
  db.put('Exams', { ...db.get('Exams', { examId: made })!, examId: EXAM_2, status: 'READY' });
  results.push(
    await send(
      publishExam,
      'POST',
      `/exams/${EXAM_2}/publish`,
      FOUNDER,
      { id: EXAM_2 },
      { body: {} },
    ),
    await send(
      setActive,
      'PUT',
      `/users/${S3_}/active`,
      FOUNDER,
      { email: S3_ },
      {
        body: { active: false, reason: 'Left' },
      },
    ),
  );
  for (const r of results) {
    expect([200, 201], JSON.stringify(r)).toContain((r as { status: number }).status);
  }
  return made;
}

describe('a super admin’s actions are applied but leave no trace for other roles', () => {
  it.each<['TEACHER' | 'BATCH_MANAGER' | 'STUDENT', string]>([
    ['TEACHER', TEACHER_A],
    ['TEACHER', TEACHER_C],
    ['BATCH_MANAGER', MANAGER],
    ['STUDENT', S1],
  ])('%s %s: no response carries the super admin', async (role, email) => {
    await superAdminActs();

    for (const [name, read] of Object.entries(readsOf(role, email))) {
      const { status, body } = (await read()) as { status: number; body: unknown };
      const text = JSON.stringify(body);
      expect(status, `${name}: ${text}`).toBeLessThan(500);
      for (const trace of TRACES) expect(text, `${name} ${trace}`).not.toMatch(trace);
    }
  });

  it('still applies the actions: the score, the appeal outcomes and the exam are all in effect', async () => {
    await superAdminActs();

    const asTeacher = teacherReads(TEACHER_A);
    const answer = (await asTeacher.answer()).body;
    expect(answer.score).toBe(9);
    expect(answer.override).toBeUndefined();

    const appeals = (await asTeacher.appeals()).body.appeals as Array<Record<string, unknown>>;
    expect(appeals.find((a) => a['appealId'] === 'ap2')).toMatchObject({
      status: 'CLOSED',
      note: CLOSING_NOTE,
    });
    expect(appeals.find((a) => a['appealId'] === 'ap1')).toMatchObject({ status: 'RERUN' });
    for (const a of appeals) expect(a).not.toHaveProperty('handledBy');

    const exams = (await asTeacher.listExams()).body.exams as Array<Record<string, unknown>>;
    expect(exams.map((e) => [e['examId'], e['status']])).toEqual(
      expect.arrayContaining([[EXAM_ID, 'PUBLISHED']]),
    );
    expect(exams.find((e) => e['examId'] === EXAM_2)).toMatchObject({ status: 'PUBLISHED' });
    expect(exams.find((e) => e['examId'] === EXAM_2)).not.toHaveProperty('createdBy');
    // A teacher's own exam still names its teacher.
    expect(exams.find((e) => e['examId'] === EXAM_ID)).toHaveProperty('createdBy');

    const student = studentReads(S1);
    const mine = (await student.myExam()).body.questions[0];
    expect(mine).toMatchObject({ score: 9, adjusted: false });
    // Re-graded by the founder: just "still being graded", like any re-grade.
    expect(mine.messages).toEqual(['Still being graded']);
    const q2 = (await student.myExam()).body.questions[1];
    expect(q2.appeal).toMatchObject({ status: 'CLOSED', note: CLOSING_NOTE });
  });

  it('keeps recording the actions in the audit log, where only a super admin can read them', async () => {
    await superAdminActs();

    expect(
      db.all<{ entityKey: string; actor: string }>('AuditLog').filter((e) => e.actor === FOUNDER)
        .length,
    ).toBeGreaterThanOrEqual(6);

    const seen = teacherReads(TEACHER_A);
    expect((await seen.audit()).body.entries).toEqual([]);

    const asFounder = await send(getAudit, 'GET', `/answers/${EXAM_ID}/${S1}/1/audit`, FOUNDER, {
      examId: EXAM_ID,
      studentEmail: S1,
      q: '1',
    });
    expect(asFounder.body.entries).toHaveLength(1);
    expect(asFounder.body.entries[0]).toMatchObject({
      actor: FOUNDER,
      actorRole: 'SUPER_ADMIN',
      reason: SECRET_REASON,
    });
  });

  it('shows a super admin everything: override, handler, creator and score history', async () => {
    const made = await superAdminActs();
    const params = { examId: EXAM_ID, studentEmail: S1, q: '1' };

    const answer = await send(getAnswer, 'GET', `/answers/${EXAM_ID}/${S1}/1`, FOUNDER, params);
    expect(answer.body.override).toMatchObject({ by: FOUNDER, byRole: 'SUPER_ADMIN', score: 9 });

    const appeals = await send(listAppeals, 'GET', '/appeals', FOUNDER, undefined, {
      query: { examId: EXAM_ID },
    });
    expect(
      appeals.body.appeals.map((a: { appealId: string; handledBy?: string }) => [
        a.appealId,
        a.handledBy,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['ap1', FOUNDER],
        ['ap2', FOUNDER],
      ]),
    );

    const exams = await send(listExams, 'GET', '/exams', FOUNDER);
    expect(exams.body.exams.find((e: { examId: string }) => e.examId === EXAM_2)).toMatchObject({
      createdBy: FOUNDER,
    });
    expect(made).toBeTruthy();

    const board = await send(getBoard, 'GET', `/exams/${EXAM_ID}/answers`, FOUNDER, {
      id: EXAM_ID,
    });
    expect(board.body.students[0].questions[0]).toMatchObject({ score: 9, overridden: true });
  });

  it('shows a teacher’s own override, with the teacher’s name, to everyone who could see it before', async () => {
    await send(
      setOverride,
      'PUT',
      `/answers/${EXAM_ID}/${S1}/1/override`,
      TEACHER_A,
      {
        examId: EXAM_ID,
        studentEmail: S1,
        q: '1',
      },
      { body: { score: 8, reason: 'Teacher reason' } },
    );

    const manager = (await managerReads(MANAGER).answer()).body;
    expect(manager.override).toMatchObject({ by: TEACHER_A, byRole: 'TEACHER', score: 8 });
    const teacher = await teacherReads(TEACHER_C).audit();
    expect(teacher.body.entries[0]).toMatchObject({ actor: TEACHER_A, actorRole: 'TEACHER' });
    const student = (await studentReads(S1).myExam()).body.questions[0];
    expect(student).toMatchObject({ score: 8, adjusted: true, adjustedBy: 'teacher' });
    expect(student.messages).toContain('Score adjusted by teacher');
  });

  it('shows a teacher who handled an appeal to the other teachers, but not to the student', async () => {
    await send(
      updateAppeal,
      'PUT',
      '/appeals/ap1',
      TEACHER_A,
      { id: 'ap1' },
      {
        body: { status: 'CLOSED', note: 'Teacher note' },
      },
    );
    const appeals = (await teacherReads(TEACHER_C).appeals()).body.appeals;
    expect(appeals.find((a: { appealId: string }) => a.appealId === 'ap1')).toMatchObject({
      handledBy: TEACHER_A,
    });
    const mine = (await studentReads(S1).myExam()).body.questions[0];
    expect(JSON.stringify(mine)).not.toContain(TEACHER_A);
  });
});

describe('the roles are what the tests assume', () => {
  it('a super admin is not a teacher, batch manager or student', () => {
    const roles: Role[] = ['TEACHER', 'BATCH_MANAGER', 'STUDENT'];
    expect(db.users.get(FOUNDER)?.role).toBe('SUPER_ADMIN');
    expect(roles).not.toContain(db.users.get(FOUNDER)?.role);
  });
});
