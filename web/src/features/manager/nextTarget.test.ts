// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { BoardStudentRow, CellStatus } from '@yulove/shared';
import {
  canUpload,
  firstOpenQuestion,
  neighbourQuestion,
  neighbourStudent,
  nextTarget,
  questionMark,
  type QueueLookup,
  type QueueStatus,
} from './nextTarget.js';

/** A student with one cell per letter: 'x' no photo, 'p' has a photo, 'g' graded. */
function student(
  email: string,
  cells: string,
  extra: Partial<BoardStudentRow> = {},
): BoardStudentRow {
  const status = (c: string): CellStatus =>
    c === 'x' ? 'NOT_SUBMITTED' : c === 'g' ? 'GRADED' : 'QUEUED';
  return {
    email,
    name: email,
    rollNo: email.toUpperCase(),
    active: true,
    absent: false,
    totalScore: 0,
    maxScore: 0,
    questions: [...cells].map((c, i) => ({
      number: i + 1,
      marks: 10,
      status: status(c),
      score: 0,
      overridden: false,
    })),
    ...extra,
  };
}

const none: QueueLookup = () => undefined;
const queued =
  (entries: Record<string, QueueStatus>): QueueLookup =>
  (email, q) =>
    entries[`${email}#${q}`];

describe('nextTarget', () => {
  const students = [
    student('a', 'xxx'),
    student('b', 'xxx', { absent: true }),
    student('c', 'pxx'),
    student('d', 'ggg'),
    student('e', 'xxx', { active: false }),
    student('f', 'xpx'),
  ];

  it('goes to the next question of the same student', () => {
    expect(nextTarget(students, none, { email: 'a', question: 1 })).toEqual({
      email: 'a',
      question: 2,
    });
    expect(nextTarget(students, none, { email: 'a', question: 2 })).toEqual({
      email: 'a',
      question: 3,
    });
  });

  it('skips questions that already have a photo, or have one waiting to be sent', () => {
    const lookup = queued({ 'a#2': 'sending' });
    expect(nextTarget(students, lookup, { email: 'a', question: 1 })).toEqual({
      email: 'a',
      question: 3,
    });
    expect(nextTarget(students, queued({ 'a#2': 'failed' }), { email: 'a', question: 1 })).toEqual({
      email: 'a',
      question: 3,
    });
  });

  it('after the last question goes to the next student who is not absent and not fully uploaded', () => {
    // b is absent, so c; c's first open question is 2.
    expect(nextTarget(students, none, { email: 'a', question: 3 })).toEqual({
      email: 'c',
      question: 2,
    });
  });

  it('skips a student whose questions all have photos, and one who is switched off', () => {
    expect(nextTarget(students, none, { email: 'c', question: 3 })).toEqual({
      email: 'f',
      question: 1,
    });
    // d is fully uploaded, e is inactive: after c comes f.
    const covered = queued({ 'c#2': 'done', 'c#3': 'queued' });
    expect(nextTarget(students, covered, { email: 'c', question: 1 })).toEqual({
      email: 'f',
      question: 1,
    });
  });

  it('counts a photo just sent from this device as uploaded before the board catches up', () => {
    const lookup = queued({ 'f#1': 'done', 'f#3': 'done' });
    expect(nextTarget(students, lookup, { email: 'c', question: 3 })).toEqual({
      email: 'a',
      question: 1,
    });
  });

  it('comes back round to the start, and to the current student last', () => {
    expect(nextTarget(students, none, { email: 'f', question: 3 })).toEqual({
      email: 'a',
      question: 1,
    });
    // Only the current student has anything left, and it is earlier than where they are.
    const lookup = queued({
      'a#2': 'done',
      'a#3': 'done',
      'c#2': 'done',
      'c#3': 'done',
      'f#1': 'done',
      'f#3': 'done',
    });
    const only = [student('a', 'xxx'), student('c', 'pxx')];
    expect(nextTarget(only, lookup, { email: 'a', question: 3 })).toEqual({
      email: 'a',
      question: 1,
    });
  });

  it('says there is nothing left when everyone is done', () => {
    const done = [student('a', 'ggg'), student('b', 'xxx', { absent: true }), student('c', 'pgp')];
    expect(nextTarget(done, none, { email: 'a', question: 3 })).toBeNull();
    expect(nextTarget([], none, { email: 'a', question: 1 })).toBeNull();
  });

  it('copes with a current student who is not in the list, and one marked absent meanwhile', () => {
    expect(nextTarget(students, none, { email: 'zz', question: 1 })).toEqual({
      email: 'a',
      question: 1,
    });
    expect(nextTarget(students, none, { email: 'b', question: 1 })).toEqual({
      email: 'c',
      question: 2,
    });
  });
});

describe('questionMark', () => {
  const cell = (status: CellStatus) =>
    student('a', 'x').questions.map((c) => ({ ...c, status }))[0]!;

  it('lets the queue override the board', () => {
    expect(questionMark(cell('NOT_SUBMITTED'), undefined)).toBe('none');
    expect(questionMark(cell('GRADED'), undefined)).toBe('photo');
    expect(questionMark(cell('FAILED_TO_GRADE'), undefined)).toBe('photo');
    expect(questionMark(cell('NOT_SUBMITTED'), 'queued')).toBe('sending');
    expect(questionMark(cell('NOT_SUBMITTED'), 'sending')).toBe('sending');
    expect(questionMark(cell('NOT_SUBMITTED'), 'done')).toBe('photo');
    expect(questionMark(cell('GRADED'), 'failed')).toBe('failed');
  });
});

describe('neighbours', () => {
  const list = [
    student('a', 'xx'),
    student('b', 'xx', { absent: true }),
    student('c', 'xx'),
    student('d', 'xx', { active: false }),
    student('e', 'xx'),
  ];

  it('steps over absent and inactive students, and stops at the ends', () => {
    expect(neighbourStudent(list, 'a', 'next')?.email).toBe('c');
    expect(neighbourStudent(list, 'c', 'next')?.email).toBe('e');
    expect(neighbourStudent(list, 'e', 'previous')?.email).toBe('c');
    expect(neighbourStudent(list, 'c', 'previous')?.email).toBe('a');
    expect(neighbourStudent(list, 'a', 'previous')).toBeUndefined();
    expect(neighbourStudent(list, 'e', 'next')).toBeUndefined();
    expect(neighbourStudent(list, 'nobody', 'next')).toBeUndefined();
  });

  it('steps through the questions, and stops at the ends', () => {
    const cells = student('a', 'xxx').questions;
    expect(neighbourQuestion(cells, 2, 'next')).toBe(3);
    expect(neighbourQuestion(cells, 2, 'previous')).toBe(1);
    expect(neighbourQuestion(cells, 1, 'previous')).toBeUndefined();
    expect(neighbourQuestion(cells, 3, 'next')).toBeUndefined();
    expect(neighbourQuestion(cells, 9, 'next')).toBeUndefined();
  });

  it('finds the first question that still needs a photo', () => {
    expect(firstOpenQuestion(student('a', 'pxx'), none)).toBe(2);
    expect(firstOpenQuestion(student('a', 'ppp'), none)).toBe(1);
    expect(firstOpenQuestion(student('a', 'xxx'), queued({ 'a#1': 'queued' }))).toBe(2);
  });

  it('knows who can have photos taken', () => {
    expect(canUpload(student('a', 'x'))).toBe(true);
    expect(canUpload(student('a', 'x', { absent: true }))).toBe(false);
    expect(canUpload(student('a', 'x', { active: false }))).toBe(false);
  });
});
