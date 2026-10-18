import { describe, expect, it } from 'vitest';
import { ANSWERS_BY_EXAM_ATTRIBUTES, ANSWERS_BY_EXAM_INDEX } from './tables.js';
import { answerIndexKeys, examStudentKey, parseExamStudentKey } from './types.js';

describe('answer index keys', () => {
  it('builds the byExam sort key from the lower-case email and the question number', () => {
    expect(answerIndexKeys('exam-1', ' Student@College.edu ', 3)).toEqual({
      examId: 'exam-1',
      studentEmail: 'student@college.edu',
      examSort: 'student@college.edu#3',
    });
  });

  it('splits a partition key back into exam and student, on the first #', () => {
    expect(parseExamStudentKey(examStudentKey('exam-1', 'A@B.edu'))).toEqual({
      examId: 'exam-1',
      studentEmail: 'a@b.edu',
    });
    expect(parseExamStudentKey('exam-1#odd#name@b.edu')).toEqual({
      examId: 'exam-1',
      studentEmail: 'odd#name@b.edu',
    });
  });

  it.each(['', 'nohash', '#nobody', 'exam-1#'])('rejects the malformed key "%s"', (key) => {
    expect(parseExamStudentKey(key)).toBeUndefined();
  });

  it('names the index and keeps its projection to what the board and totals need', () => {
    expect(ANSWERS_BY_EXAM_INDEX).toBe('byExam');
    expect(ANSWERS_BY_EXAM_ATTRIBUTES).toEqual(
      expect.arrayContaining([
        'status',
        'testsPassed',
        'testsTotal',
        'meetsComplexity',
        'override',
      ]),
    );
    for (const heavy of ['rawTranscription', 'correctedCode', 'driverCode', 'verdicts', 'fixes']) {
      expect(ANSWERS_BY_EXAM_ATTRIBUTES).not.toContain(heavy);
    }
  });
});
