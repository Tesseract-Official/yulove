import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { invoke, makeEvent } from '../test-utils/events.js';
import { EXAM_ID } from '../test-utils/exams.js';
import { OTHER_TEACHER } from '../test-utils/questions.js';
import {
  answerItem,
  examStudentRow,
  MANAGER,
  TEACHER_A,
  TEACHER_B,
  seedGradingWorld,
} from '../test-utils/answers.js';
import { handler } from './get-exam-results.js';

const db = new FakeDb();
const call = (email: string, id = EXAM_ID) =>
  invoke(
    handler,
    makeEvent({ method: 'GET', path: `/exams/${id}/results`, email, pathParameters: { id } }),
  );

beforeEach(() => {
  db.reset();
  seedGradingWorld(db);
});

describe('GET /exams/{id}/results', () => {
  it('lists each student by name and roll number with per-question scores and the total', async () => {
    db.put('Answers', answerItem('s1@college.edu', 1)); // 5 of 10
    db.put('Answers', answerItem('s1@college.edu', 2, { testsPassed: 10 })); // 5 of 5
    db.put('Answers', answerItem('s2@college.edu', 1, { testsPassed: 7 })); // 7

    const { status, body } = await call(TEACHER_A);

    expect(status).toBe(200);
    expect(body).toMatchObject({ examId: EXAM_ID, title: 'Week 3 test', maxScore: 15 });
    const [s1, s2, s3] = body.students;
    expect(s1).toMatchObject({
      name: 'STUDENT user',
      rollNo: 'R1',
      email: 's1@college.edu',
      absent: false,
      totalScore: 10,
      maxScore: 15,
      failedToGrade: 0,
    });
    expect(s1.questions.map((q: { score: number }) => q.score)).toEqual([5, 5]);
    expect(s2.questions.map((q: { score: number }) => q.score)).toEqual([7, 0]);
    expect(s2.totalScore).toBe(7);
    expect(s3.totalScore).toBe(0);
  });

  it('shows an absent student as absent, with every score 0', async () => {
    db.put('Answers', answerItem('s1@college.edu', 1));
    db.put('ExamStudents', examStudentRow('s1@college.edu', { absent: true }));

    const [s1] = (await call(TEACHER_A)).body.students;

    expect(s1).toMatchObject({ absent: true, totalScore: 0, maxScore: 15 });
    expect(s1.questions.map((q: { score: number }) => q.score)).toEqual([0, 0]);
  });

  it('shows a question that could not be graded clearly, not as a plain 0', async () => {
    db.put(
      'Answers',
      answerItem('s1@college.edu', 1, {
        status: 'FAILED_TO_GRADE',
        failReason: 'UNREADABLE',
        failDetail: 'The page could not be read',
      }),
    );
    db.put('Answers', answerItem('s1@college.edu', 2, { testsPassed: 0 }));

    const [s1] = (await call(TEACHER_A)).body.students;

    expect(s1.failedToGrade).toBe(1);
    expect(s1.questions[0]).toMatchObject({
      status: 'FAILED_TO_GRADE',
      failedToGrade: true,
      failReason: 'UNREADABLE',
      failDetail: 'The page could not be read',
      score: 0,
    });
    expect(s1.questions[1]).toMatchObject({ status: 'GRADED', failedToGrade: false, score: 0 });
  });

  it('shows an override instead of the formula score, and a missed complexity as 0', async () => {
    db.put(
      'Answers',
      answerItem('s1@college.edu', 1, { override: { score: 9, reason: 'r', by: 'a', at: 't' } }),
    );
    db.put('Answers', answerItem('s2@college.edu', 1, { testsPassed: 10, meetsComplexity: false }));

    const { students } = (await call(TEACHER_A)).body;
    expect(students[0].questions[0]).toMatchObject({ score: 9, overridden: true });
    expect(students[1].questions[0]).toMatchObject({ score: 0, overridden: false });
  });

  it('marks questions with no answer yet', async () => {
    const [s1] = (await call(TEACHER_A)).body.students;
    expect(s1.questions[0].status).toBe('NOT_SUBMITTED');
  });

  it("is open to any teacher of the batch, not only the exam's creator", async () => {
    expect((await call(OTHER_TEACHER)).status).toBe(200);
  });

  it('lets a super admin read it', async () => {
    expect((await call('super-admin@college.edu')).status).toBe(200);
  });

  it.each([
    ['a batch manager', MANAGER],
    ['a student', 's1@college.edu'],
    ['a teacher of another batch', TEACHER_B],
  ])('refuses %s with 403', async (_who, email) => {
    expect((await call(email)).status).toBe(403);
  });

  it('answers 404 for an unknown exam', async () => {
    expect((await call(TEACHER_A, 'nope')).status).toBe(404);
  });
});

describe('how the answers are read', () => {
  it('reads every answer of the exam with one query on the byExam index, not one per student', async () => {
    db.put('Answers', answerItem('s3@college.edu', 1));

    const { status } = await call(TEACHER_A);

    expect(status).toBe(200);
    const answerQueries = db
      .commandCalls(QueryCommand)
      .map((c) => c.input as { TableName: string; IndexName?: string })
      .filter((input) => input.TableName === 'Answers');
    expect(answerQueries).toEqual([expect.objectContaining({ IndexName: 'byExam' })]);
  });
});
