import type { QuestionItem } from '@yulove/shared';
import { FakeDb } from '@yulove/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { OTHER_TEACHER, questionItem, seedPeople, TEACHER } from '../test-utils/questions.js';
import { handler } from './approve-question.js';

const db = new FakeDb();
const call = (email: string, id = 'q1') =>
  invoke(
    handler,
    makeEvent({
      method: 'POST',
      path: `/questions/${id}/approve`,
      email,
      pathParameters: { id },
    }),
  );

const status = () =>
  db.get<QuestionItem>('Questions', { questionId: 'q1', version: 1 })?.testStatus;

beforeEach(() => {
  db.reset();
  db.addBatch('A');
  seedPeople(db);
});

describe('POST /questions/{id}/approve', () => {
  it('approves a question in NEEDS_REVIEW', async () => {
    db.put('Questions', questionItem({ testStatus: 'NEEDS_REVIEW' }));

    const result = await call(TEACHER);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ questionId: 'q1', version: 1, testStatus: 'APPROVED' });
    expect(status()).toBe('APPROVED');
  });

  it('lets a super admin approve any question', async () => {
    db.put('Questions', questionItem({ testStatus: 'NEEDS_REVIEW' }));
    expect((await call('super-admin@college.edu')).status).toBe(200);
    expect(status()).toBe('APPROVED');
  });

  it.each(['GENERATING', 'APPROVED', 'GENERATION_FAILED', undefined] as const)(
    'answers 409 and changes nothing when the question is %s',
    async (state) => {
      db.put('Questions', questionItem(state ? { testStatus: state } : {}));

      const result = await call(TEACHER);

      expect(result.status).toBe(409);
      expect(result.body.error.message).toMatch(/NEEDS_REVIEW/);
      expect(status()).toBe(state);
    },
  );

  it('approves only the latest version', async () => {
    db.put('Questions', questionItem({ version: 1, testStatus: 'NEEDS_REVIEW' }));
    db.put('Questions', questionItem({ version: 2, testStatus: 'GENERATING' }));

    expect((await call(TEACHER)).status).toBe(409);
    expect(db.get<QuestionItem>('Questions', { questionId: 'q1', version: 1 })?.testStatus).toBe(
      'NEEDS_REVIEW',
    );
  });

  it.each(deniedRoles('TEACHER'))('refuses a %s with 403', async (role) => {
    db.put('Questions', questionItem({ testStatus: 'NEEDS_REVIEW' }));
    expect((await call(userOf(role).email)).status).toBe(403);
    expect(status()).toBe('NEEDS_REVIEW');
  });

  it("refuses another teacher's question with 403", async () => {
    db.put('Questions', questionItem({ testStatus: 'NEEDS_REVIEW' }));
    expect((await call(OTHER_TEACHER)).status).toBe(403);
    expect(status()).toBe('NEEDS_REVIEW');
  });

  it('answers 404 for an unknown question', async () => {
    expect((await call(TEACHER, 'nope')).status).toBe(404);
  });
});
