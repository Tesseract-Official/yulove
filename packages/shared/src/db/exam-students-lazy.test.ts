import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '../testing/fake-db.js';
import { getOrCreateExamStudent } from './exam-students.js';

describe('getOrCreateExamStudent', () => {
  const db = new FakeDb();

  beforeEach(() => db.reset());

  it('creates the row on first access', async () => {
    const row = await getOrCreateExamStudent('e1', 'Late@College.edu');

    expect(row).toEqual({ examId: 'e1', studentEmail: 'late@college.edu', absent: false });
    expect(db.get('ExamStudents', { examId: 'e1', studentEmail: 'late@college.edu' })).toEqual(row);
  });

  it('returns the existing row without changing it', async () => {
    db.put('ExamStudents', {
      examId: 'e1',
      studentEmail: 'a@college.edu',
      absent: true,
      totalScore: 7,
    });

    const row = await getOrCreateExamStudent('e1', 'A@College.edu');

    expect(row).toEqual({
      examId: 'e1',
      studentEmail: 'a@college.edu',
      absent: true,
      totalScore: 7,
    });
  });

  it('is safe to call twice at once', async () => {
    const [a, b] = await Promise.all([
      getOrCreateExamStudent('e1', 'race@college.edu'),
      getOrCreateExamStudent('e1', 'race@college.edu'),
    ]);

    expect(a).toEqual(b);
    expect(db.all('ExamStudents')).toHaveLength(1);
  });
});
