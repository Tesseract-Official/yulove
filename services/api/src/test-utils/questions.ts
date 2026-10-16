import type { QuestionItem } from '@yulove/shared';
import type { FakeDb } from '@yulove/shared/testing';
import { userOf } from './events.js';

export const TEACHER = 'teacher@college.edu';
export const OTHER_TEACHER = 'other-teacher@college.edu';

/** The request body a teacher sends: the editable content of a question. */
export const questionContent = {
  title: 'Two Sum',
  statement: 'Find two numbers that add up to the target.',
  ioDescription: 'Input: nums and target. Output: two indexes.',
  constraints: '2 <= n <= 100000',
  examples: [{ input: '[2,7] 9', output: '[0,1]' }],
  targetComplexity: 'O(n)',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT' as const,
};

export const signature = {
  name: 'twoSum',
  parameters: [
    { name: 'nums', type: 'int[]' },
    { name: 'target', type: 'int' },
  ],
  returnType: 'int[]',
};

export function questionItem(extra: Partial<QuestionItem> = {}): QuestionItem {
  return {
    questionId: 'q1',
    version: 1,
    teacherEmail: TEACHER,
    ...questionContent,
    ...extra,
  };
}

/** Users for every role, so tests can try each. */
export function seedPeople(db: FakeDb): void {
  db.addUser(userOf('SUPER_ADMIN'));
  db.addUser(userOf('TEACHER', { email: TEACHER, batchIds: ['A'] }));
  db.addUser(userOf('TEACHER', { email: OTHER_TEACHER, batchIds: ['A'] }));
  db.addUser(userOf('BATCH_MANAGER', { batchIds: ['A'] }));
  db.addUser(userOf('STUDENT', { email: 's1@college.edu', batchId: 'A', rollNo: 'R1' }));
}
