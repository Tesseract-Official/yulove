import type { BoardStudentRow, QuestionCell } from '@yulove/shared';
import { hasPhoto } from '../common/labels.js';

/** Where a photo taken on this device is on its way to the server. */
export type QueueStatus = 'queued' | 'sending' | 'done' | 'failed';

/** What a student's question looks like in the progress row. */
export type Mark = 'photo' | 'sending' | 'failed' | 'none';

/** What this device knows about the photos it was asked to send. */
export type QueueLookup = (studentEmail: string, question: number) => QueueStatus | undefined;

export interface Target {
  email: string;
  question: number;
}

/** The mark for one question: the queue's news beats the board's, which may not be refreshed yet. */
export function questionMark(cell: QuestionCell, queued: QueueStatus | undefined): Mark {
  if (queued === 'failed') return 'failed';
  if (queued === 'queued' || queued === 'sending') return 'sending';
  if (queued === 'done' || hasPhoto(cell.status)) return 'photo';
  return 'none';
}

/** Nothing more to take for this question: it has a photo, or a photo is waiting to go. */
export const isCovered = (cell: QuestionCell, queued: QueueStatus | undefined): boolean =>
  queued !== undefined || hasPhoto(cell.status);

/** Someone photos can be taken for: switched on and not marked absent. */
export const canUpload = (student: BoardStudentRow): boolean => student.active && !student.absent;

const openQuestions = (student: BoardStudentRow, lookup: QueueLookup): QuestionCell[] =>
  student.questions.filter((cell) => !isCovered(cell, lookup(student.email, cell.number)));

/**
 * Where to point the camera after a photo of `current` has been taken:
 *  1. the next question of the same student that still needs a photo;
 *  2. otherwise the next student in the list (then round to the start) who is not absent and
 *     still has a question without a photo, at their first such question;
 *  3. otherwise nothing: everyone is done.
 * A student's earlier questions that were skipped are only come back to after everyone else.
 */
export function nextTarget(
  students: readonly BoardStudentRow[],
  lookup: QueueLookup,
  current: Target,
): Target | null {
  const index = students.findIndex((s) => s.email === current.email);
  const here = students[index];
  if (here && canUpload(here)) {
    const next = openQuestions(here, lookup).find((cell) => cell.number > current.question);
    if (next) return { email: here.email, question: next.number };
  }

  const order =
    index < 0 ? [...students] : [...students.slice(index + 1), ...students.slice(0, index + 1)];
  for (const student of order) {
    if (!canUpload(student)) continue;
    const open = openQuestions(student, lookup)[0];
    if (open) return { email: student.email, question: open.number };
  }
  return null;
}

/** The previous or next student in the list that photos can be taken for; none at the ends. */
export function neighbourStudent(
  students: readonly BoardStudentRow[],
  email: string,
  direction: 'previous' | 'next',
): BoardStudentRow | undefined {
  const index = students.findIndex((s) => s.email === email);
  if (index < 0) return undefined;
  const candidates =
    direction === 'next' ? students.slice(index + 1) : students.slice(0, index).reverse();
  return candidates.find(canUpload);
}

/** The previous or next question number of a student; none at the ends. */
export function neighbourQuestion(
  cells: readonly QuestionCell[],
  question: number,
  direction: 'previous' | 'next',
): number | undefined {
  const numbers = cells.map((c) => c.number).sort((a, b) => a - b);
  const index = numbers.indexOf(question);
  if (index < 0) return undefined;
  return numbers[direction === 'next' ? index + 1 : index - 1];
}

/** The first question that needs a photo, for a student about to be photographed. */
export function firstOpenQuestion(student: BoardStudentRow, lookup: QueueLookup): number {
  return openQuestions(student, lookup)[0]?.number ?? student.questions[0]?.number ?? 1;
}

/** True when no student who can have photos taken still has a question without a photo. */
export const allCovered = (students: readonly BoardStudentRow[], lookup: QueueLookup): boolean =>
  students.every((student) => !canUpload(student) || openQuestions(student, lookup).length === 0);
