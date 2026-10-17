import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID, examItem } from '../test-utils/exams.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  seedGradingWorld,
  TEACHER_A,
} from '../test-utils/answers.js';
import { handler } from './get-my-exams.js';

const db = new FakeDb();
const call = (email: string) =>
  invoke(handler, makeEvent({ method: 'GET', path: '/me/exams', email }));

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
  db.put('Exams', examItem({ status: 'PUBLISHED' }));
  db.put('Answers', answerItem('s1@college.edu', 1)); // 5
  db.put('Answers', answerItem('s1@college.edu', 2)); // 2.5
  db.put('Answers', answerItem('s2@college.edu', 1, { testsPassed: 10 })); // 10
});

describe('GET /me/exams', () => {
  it("lists the published exams of the student's batch with their own total", async () => {
    const { status, body } = await call('s1@college.edu');

    expect(status).toBe(200);
    expect(body.exams).toEqual([
      {
        examId: EXAM_ID,
        title: 'Week 3 test',
        date: '2026-10-24',
        absent: false,
        totalScore: 7.5,
        maxScore: 15,
      },
    ]);
  });

  it("shows another student their own total, never the first student's", async () => {
    const { body } = await call('s2@college.edu');
    expect(body.exams[0].totalScore).toBe(10);
    expect(JSON.stringify(body)).not.toContain('s1@college.edu');
  });

  it('leaves out exams that are not published, and exams of other batches', async () => {
    db.put('Exams', examItem({ examId: 'ready', status: 'READY' }));
    db.put('Exams', examItem({ examId: 'draft', status: 'DRAFT' }));
    db.put('Exams', examItem({ examId: 'other', status: 'PUBLISHED', batchId: 'B' }));

    const ids = (await call('s1@college.edu')).body.exams.map((e: { examId: string }) => e.examId);
    expect(ids).toEqual([EXAM_ID]);
  });

  it('lists exams newest first', async () => {
    db.put('Exams', examItem({ examId: 'later', status: 'PUBLISHED', date: '2026-11-30' }));
    const ids = (await call('s1@college.edu')).body.exams.map((e: { examId: string }) => e.examId);
    expect(ids).toEqual(['later', EXAM_ID]);
  });

  it('shows an absent student as absent with a total of 0', async () => {
    db.put('ExamStudents', examStudentRow('s1@college.edu', { absent: true }));
    expect((await call('s1@college.edu')).body.exams[0]).toMatchObject({
      absent: true,
      totalScore: 0,
    });
  });

  it('is an empty list when nothing is published', async () => {
    db.put('Exams', examItem({ status: 'READY' }));
    expect((await call('s1@college.edu')).body.exams).toEqual([]);
  });

  it.each([
    ['a teacher', TEACHER_A],
    ['a batch manager', MANAGER],
  ])('refuses %s with 403', async (_who, email) => {
    expect((await call(email)).status).toBe(403);
  });

  it('refuses an inactive student', async () => {
    expect((await call('inactive@college.edu')).status).toBe(403);
  });

  it('gives a super admin (who has no batch) an empty list', async () => {
    expect((await call('super-admin@college.edu')).body.exams).toEqual([]);
  });
});
