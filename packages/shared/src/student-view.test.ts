import { describe, expect, it } from 'vitest';
import { appealView, latestAppeal, MESSAGES, studentQuestionView } from './student-view.js';
import type { AnswerItem, AppealItem, TestVerdict } from './types.js';

const answer = (extra: Partial<AnswerItem> = {}): AnswerItem => ({
  examStudent: 'e#s',
  questionNumber: 1,
  attempt: 1,
  status: 'GRADED',
  imageKey: 'answers/e/R1/q1.jpg',
  rawTranscription: 'RAW SECRET',
  correctedCode: 'CODE SECRET',
  driverCode: 'DRIVER SECRET',
  fixes: ['FIX SECRET'],
  language: 'python',
  estimatedComplexity: 'O(n^2)',
  meetsComplexity: true,
  testsPassed: 8,
  testsTotal: 10,
  score: 8,
  ...extra,
});
const view = (a: AnswerItem | undefined, extra: Record<string, unknown> = {}) =>
  studentQuestionView({
    number: 1,
    marks: 10,
    answer: a,
    absent: false,
    targetComplexity: 'O(n)',
    ...extra,
  });

const appeal = (extra: Partial<AppealItem> = {}): AppealItem => ({
  appealId: 'a1',
  examId: 'e',
  studentEmail: 's@college.edu',
  questionNumber: 1,
  message: 'Please check',
  status: 'OPEN',
  createdAt: '2026-10-20T10:00:00.000Z',
  ...extra,
});

describe('studentQuestionView', () => {
  it('shows marks scored, tests passed out of total and no messages for a clean answer', () => {
    expect(view(answer({ verdicts: [] }))).toMatchObject({
      status: 'GRADED',
      marks: 10,
      score: 8,
      testsPassed: 8,
      testsTotal: 10,
      messages: [],
      failedSmallTests: [],
      failedLargeTests: [],
      adjusted: false,
      canAppeal: true,
    });
  });

  it('shows each failed small test with its input, expected and actual output, cut to 200', () => {
    const verdicts: TestVerdict[] = [
      { index: 0, kind: 'small', verdict: 'AC' },
      {
        index: 2,
        kind: 'small',
        verdict: 'WA',
        input: 'i'.repeat(500),
        expected: '6',
        actual: 'o'.repeat(300),
      },
      { index: 4, kind: 'small', verdict: 'RE', input: '{"x":1}' },
    ];
    const { failedSmallTests } = view(answer({ verdicts }));

    expect(failedSmallTests).toEqual([
      {
        index: 2,
        verdict: 'WA',
        input: `${'i'.repeat(197)}...`,
        expected: '6',
        actual: `${'o'.repeat(197)}...`,
      },
      { index: 4, verdict: 'RE', input: '{"x":1}' },
    ]);
  });

  it('shows a failed large test as "Large test N" and its verdict, and nothing else', () => {
    const verdicts: TestVerdict[] = [
      {
        index: 7,
        kind: 'large',
        verdict: 'TLE',
        input: 'SECRET INPUT',
        expected: 'SECRET',
        actual: 'x',
      },
      { index: 9, kind: 'large', verdict: 'MLE' },
      { index: 8, kind: 'large', verdict: 'AC' },
    ];
    const { failedLargeTests } = view(answer({ verdicts }));

    expect(failedLargeTests).toEqual([
      { label: 'Large test 1', verdict: 'TLE', message: 'Large test 1: time limit exceeded' },
      { label: 'Large test 3', verdict: 'MLE', message: 'Large test 3: memory limit exceeded' },
    ]);
    expect(JSON.stringify(failedLargeTests)).not.toContain('SECRET');
  });

  it('says when the time complexity rule zeroed the question, naming the target', () => {
    const v = view(answer({ meetsComplexity: false, testsPassed: 10, score: 10 }));
    expect(v.messages).toEqual(['Did not meet the required time complexity, O(n)']);
    expect(v.score).toBe(0);
    expect(MESSAGES.complexity('O(n log n)')).toBe(
      'Did not meet the required time complexity, O(n log n)',
    );
  });

  it('says a question could not be graded and offers an appeal, without the reason', () => {
    const v = view(
      answer({ status: 'FAILED_TO_GRADE', failReason: 'UNREADABLE', failDetail: 'blurry' }),
    );
    expect(v).toMatchObject({
      status: 'FAILED_TO_GRADE',
      messages: ['Could not be graded — raise an appeal'],
      score: 0,
      canAppeal: true,
    });
    expect(JSON.stringify(v)).not.toMatch(/UNREADABLE|blurry/);
  });

  it('shows Absent across the question, with score 0 and no detail', () => {
    const v = studentQuestionView({ number: 1, marks: 10, answer: answer(), absent: true });
    expect(v).toMatchObject({ status: 'ABSENT', messages: ['Absent'], score: 0, canAppeal: false });
    expect(v.testsPassed).toBeUndefined();
  });

  it('shows a super admin’s override as the score only: no label, no trace of who or why', () => {
    const v = view(
      answer({
        override: {
          score: 9,
          reason: 'PRIVATE REASON',
          by: 'admin@x.com',
          byRole: 'SUPER_ADMIN',
          at: 't',
        },
      }),
    );
    expect(v).toMatchObject({ score: 9, adjusted: false });
    expect(v).not.toHaveProperty('adjustedBy');
    expect(v.messages).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/PRIVATE REASON|admin|SUPER_ADMIN/i);
  });

  it('says "Score adjusted by teacher" for a teacher’s override, without their name, email or reason', () => {
    const v = view(
      answer({
        override: {
          score: 9,
          reason: 'PRIVATE REASON',
          by: 'tina@x.com',
          byRole: 'TEACHER',
          at: 't',
        },
      }),
    );
    expect(v).toMatchObject({ score: 9, adjusted: true, adjustedBy: 'teacher' });
    expect(v.messages).toContain('Score adjusted by teacher');
    expect(JSON.stringify(v)).not.toMatch(/PRIVATE REASON|tina@x.com|TEACHER|"by"/);
  });

  it('reads an override from before roles were recorded as a super admin’s: no label', () => {
    const v = view(answer({ override: { score: 9, reason: 'r', by: 'old@x.com', at: 't' } }));
    expect(v).toMatchObject({ score: 9, adjusted: false });
    expect(v.messages).toEqual([]);
  });

  it('says whether there is a photo to look at, without saying where it is', () => {
    expect(view(answer({ imageKey: 'answers/e/R1/q1.jpg' }))).toMatchObject({ hasPhoto: true });
    const noPhoto = answer();
    delete noPhoto.imageKey;
    expect(view(noPhoto)).toMatchObject({ hasPhoto: false });
    expect(view(undefined)).toMatchObject({ hasPhoto: false });
    expect(JSON.stringify(view(answer({ imageKey: 'answers/e/R1/q1.jpg' })))).not.toContain(
      'answers/',
    );
  });

  it('treats unfinished and missing answers as such', () => {
    for (const status of ['QUEUED', 'TRANSCRIBING', 'RUNNING'] as const) {
      expect(view(answer({ status }))).toMatchObject({
        status: 'IN_PROGRESS',
        score: 0,
        canAppeal: false,
      });
    }
    expect(view(undefined)).toMatchObject({ status: 'NOT_SUBMITTED', score: 0, canAppeal: false });
  });

  describe('appeals', () => {
    it('shows the status and the reviewer note, not who handled it', () => {
      const v = view(answer(), {
        appeal: appeal({
          status: 'CLOSED',
          note: 'Marked correctly',
          handledBy: 'staff@college.edu',
        }),
      });
      expect(v.appeal).toEqual({
        appealId: 'a1',
        status: 'CLOSED',
        message: 'Please check',
        note: 'Marked correctly',
        createdAt: '2026-10-20T10:00:00.000Z',
      });
      expect(JSON.stringify(v)).not.toContain('staff@college.edu');
      expect(v.canAppeal).toBe(true);
    });

    it('cannot appeal again while one is open, but can after RERUN or CLOSED', () => {
      expect(view(answer(), { appeal: appeal({ status: 'OPEN' }) }).canAppeal).toBe(false);
      expect(view(answer(), { appeal: appeal({ status: 'RERUN' }) }).canAppeal).toBe(true);
      expect(view(answer(), { appeal: appeal({ status: 'CLOSED' }) }).canAppeal).toBe(true);
    });

    it('picks the newest appeal', () => {
      expect(
        latestAppeal([
          appeal({ appealId: 'old', createdAt: '2026-10-01T00:00:00Z' }),
          appeal({ appealId: 'new', createdAt: '2026-10-02T00:00:00Z' }),
        ])?.appealId,
      ).toBe('new');
      expect(latestAppeal([])).toBeUndefined();
      expect(appealView(appeal()).note).toBeUndefined();
    });
  });

  it('never carries the hidden fields of the answer', () => {
    const v = view(
      answer({
        verdicts: [
          { index: 1, kind: 'small', verdict: 'WA', input: 'in', expected: 'ex', actual: 'ac' },
        ],
        failReason: 'WORKER_ERROR',
        transcribeTries: 2,
        openAppealId: 'a1',
      }),
    );
    const text = JSON.stringify(v);
    for (const secret of [
      'SECRET',
      'answers/e/R1',
      'WORKER_ERROR',
      'python',
      'O(n^2)',
      'attempt',
      'imageKey',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
