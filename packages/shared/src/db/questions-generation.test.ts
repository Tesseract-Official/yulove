import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '../testing/fake-db.js';
import type { QuestionItem } from '../types.js';
import {
  advanceGeneration,
  approveQuestion,
  beginGeneration,
  countGenerationTry,
  getLatestQuestion,
  markGenerationFailed,
  resetQuestionTests,
  saveTestsReady,
  saveSignature,
  updateQuestion,
} from './questions.js';

const db = new FakeDb();

const question = (extra: Partial<QuestionItem> = {}): QuestionItem => ({
  questionId: 'q1',
  version: 1,
  teacherEmail: 'teacher@college.edu',
  title: 'T',
  statement: 'S',
  ioDescription: 'IO',
  constraints: 'C',
  examples: [{ input: '1', output: '2' }],
  targetComplexity: 'O(n)',
  timeLimitMs: 1000,
  memoryMb: 256,
  compareMode: 'EXACT',
  ...extra,
});

const stored = () => db.get<QuestionItem>('Questions', { questionId: 'q1', version: 1 });

beforeEach(() => {
  db.reset();
  db.put('Questions', question());
});

describe('beginGeneration', () => {
  it('starts round 1: GENERATING and testAttempt 1', async () => {
    await expect(beginGeneration('q1', 1)).resolves.toBe(1);
    expect(stored()).toMatchObject({ testStatus: 'GENERATING', testAttempt: 1 });
  });

  it('resets the replacement counter for a fresh generation', async () => {
    db.put('Questions', question({ testAttempt: 3, testRegenerations: 2 }));

    await beginGeneration('q1', 1);

    expect(stored()?.testRegenerations).toBe(0);
  });

  it('counts rounds and clears an earlier failure', async () => {
    db.put(
      'Questions',
      question({ testStatus: 'GENERATION_FAILED', testFailure: 'boom', testAttempt: 4 }),
    );

    await expect(beginGeneration('q1', 1)).resolves.toBe(5);
    expect(stored()?.testFailure).toBeUndefined();
    expect(stored()?.testStatus).toBe('GENERATING');
  });

  it('returns undefined for a version that does not exist', async () => {
    await expect(beginGeneration('q1', 9)).resolves.toBeUndefined();
  });
});

describe('writes guarded by the generation round', () => {
  beforeEach(() => {
    db.put('Questions', question({ testStatus: 'GENERATING', testAttempt: 2 }));
  });

  it('saveSignature writes for the current round and not for an old one', async () => {
    const signature = {
      name: 'twoSum',
      parameters: [{ name: 'nums', type: 'int[]' }],
      returnType: 'int[]',
    };

    await expect(saveSignature('q1', 1, 1, signature)).resolves.toBe('stale');
    expect(stored()?.signature).toBeUndefined();

    await expect(saveSignature('q1', 1, 2, signature)).resolves.toBe('written');
    expect(stored()?.signature).toEqual(signature);
  });

  it('markGenerationFailed records the reason for the current round only', async () => {
    await expect(markGenerationFailed('q1', 1, 1, 'old')).resolves.toBe('stale');
    expect(stored()?.testStatus).toBe('GENERATING');

    await expect(markGenerationFailed('q1', 1, 2, 'Gemini returned 6 small inputs')).resolves.toBe(
      'written',
    );
    expect(stored()).toMatchObject({
      testStatus: 'GENERATION_FAILED',
      testFailure: 'Gemini returned 6 small inputs',
    });
  });

  it('advanceGeneration moves to the next round and counts a replacement, or reports stale', async () => {
    await expect(advanceGeneration('q1', 1, 1)).resolves.toBe('stale');
    await expect(advanceGeneration('q1', 1, 2)).resolves.toBe(3);
    expect(stored()).toMatchObject({
      testStatus: 'GENERATING',
      testAttempt: 3,
      testRegenerations: 1,
    });
    await expect(advanceGeneration('q1', 1, 3)).resolves.toBe(4);
    expect(stored()?.testRegenerations).toBe(2);
  });

  it('a late write from the replaced round loses', async () => {
    await advanceGeneration('q1', 1, 2);
    await expect(markGenerationFailed('q1', 1, 2, 'late')).resolves.toBe('stale');
  });
});

describe('approveQuestion', () => {
  it('approves only from NEEDS_REVIEW', async () => {
    db.put('Questions', question({ testStatus: 'NEEDS_REVIEW' }));
    await expect(approveQuestion('q1', 1)).resolves.toBe(true);
    expect(stored()?.testStatus).toBe('APPROVED');
  });

  it.each(['GENERATING', 'APPROVED', 'GENERATION_FAILED', undefined] as const)(
    'refuses from %s',
    async (status) => {
      db.put('Questions', question(status ? { testStatus: status } : {}));
      await expect(approveQuestion('q1', 1)).resolves.toBe(false);
      expect(stored()?.testStatus).toBe(status);
    },
  );
});

describe('updateQuestion and resetQuestionTests', () => {
  it('updates fields and reports a missing version', async () => {
    await expect(updateQuestion('q1', 1, { title: 'New' })).resolves.toBe(true);
    expect(stored()?.title).toBe('New');
    await expect(updateQuestion('q1', 7, { title: 'New' })).resolves.toBe(false);
  });

  it('reset clears tests, signature and status, and bumps the round', async () => {
    db.put(
      'Questions',
      question({
        testStatus: 'APPROVED',
        testCount: 10,
        testsKey: 'k',
        testAttempt: 3,
        testFailure: 'x',
        testRegenerations: 2,
        signature: { name: 'f', parameters: [], returnType: 'int' },
      }),
    );

    await resetQuestionTests('q1', 1, { statement: 'Changed' });

    const item = stored();
    expect(item?.statement).toBe('Changed');
    for (const field of [
      'testStatus',
      'testCount',
      'testsKey',
      'signature',
      'testFailure',
    ] as const) {
      expect(item?.[field]).toBeUndefined();
    }
    expect(item?.testAttempt).toBe(4);
  });
});

describe('getLatestQuestion', () => {
  it('returns the highest version', async () => {
    db.put('Questions', question({ version: 2, title: 'v2' }));
    db.put('Questions', question({ version: 10, title: 'v10' }));

    await expect(getLatestQuestion('q1')).resolves.toMatchObject({ version: 10, title: 'v10' });
  });
});

describe('countGenerationTry', () => {
  beforeEach(() => {
    db.put('Questions', question({ testStatus: 'GENERATING', testAttempt: 2 }));
  });

  it('counts tries for the current round', async () => {
    await expect(countGenerationTry('q1', 1, 2)).resolves.toBe(1);
    await expect(countGenerationTry('q1', 1, 2)).resolves.toBe(2);
    expect(stored()?.testGenTries).toBe(2);
  });

  it("is 'stale' for a round that has been replaced, and does not count it", async () => {
    await expect(countGenerationTry('q1', 1, 1)).resolves.toBe('stale');
    expect(stored()).not.toHaveProperty('testGenTries');
  });

  it('starts again from zero in a new round, after replacing inputs, on failure and on a content reset', async () => {
    db.put('Questions', question({ testStatus: 'GENERATING', testAttempt: 2, testGenTries: 2 }));
    await beginGeneration('q1', 1);
    expect(stored()).not.toHaveProperty('testGenTries');

    db.put('Questions', question({ testStatus: 'GENERATING', testAttempt: 2, testGenTries: 2 }));
    await advanceGeneration('q1', 1, 2);
    expect(stored()).not.toHaveProperty('testGenTries');

    db.put('Questions', question({ testStatus: 'GENERATING', testAttempt: 2, testGenTries: 2 }));
    await markGenerationFailed('q1', 1, 2, 'busy');
    expect(stored()).not.toHaveProperty('testGenTries');

    db.put('Questions', question({ testStatus: 'GENERATING', testAttempt: 2, testGenTries: 2 }));
    await resetQuestionTests('q1', 1, { title: 'New' });
    expect(stored()).not.toHaveProperty('testGenTries');
  });
});

describe('saveTestsReady', () => {
  const ready = { testsKey: 'questions/q1/v1/tests.json', testCount: 10 };

  beforeEach(() => {
    db.put(
      'Questions',
      question({ testStatus: 'GENERATING', testAttempt: 3, testGenTries: 1, testFailure: 'old' }),
    );
  });

  it('moves the current round to NEEDS_REVIEW with the tests and clears old failure data', async () => {
    await expect(saveTestsReady('q1', 1, 3, ready)).resolves.toBe('written');
    expect(stored()).toMatchObject({
      testStatus: 'NEEDS_REVIEW',
      testCount: 10,
      testsKey: 'questions/q1/v1/tests.json',
      testAttempt: 3,
    });
    expect(stored()).not.toHaveProperty('testFailure');
    expect(stored()).not.toHaveProperty('testGenTries');
  });

  it("is 'stale' for another round and changes nothing", async () => {
    await expect(saveTestsReady('q1', 1, 2, ready)).resolves.toBe('stale');
    expect(stored()).toMatchObject({ testStatus: 'GENERATING' });
  });

  it("is 'stale' for a result that was already recorded, even after approval", async () => {
    await saveTestsReady('q1', 1, 3, ready);
    await expect(saveTestsReady('q1', 1, 3, { ...ready, testCount: 9 })).resolves.toBe('stale');
    expect(stored()?.testCount).toBe(10);

    await approveQuestion('q1', 1);
    await expect(saveTestsReady('q1', 1, 3, ready)).resolves.toBe('stale');
    expect(stored()?.testStatus).toBe('APPROVED');
  });

  it("is 'stale' once the round failed", async () => {
    await markGenerationFailed('q1', 1, 3, 'nope');
    await expect(saveTestsReady('q1', 1, 3, ready)).resolves.toBe('stale');
    expect(stored()?.testStatus).toBe('GENERATION_FAILED');
  });
});
