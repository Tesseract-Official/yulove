import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMark, describePlan, planMark } from './mark-dev-data.js';
import { planCleanup } from './cleanup-dev-data.js';
import { FakeAws } from './dev-data.test-support.js';

const fake = new FakeAws();
const aws = fake.aws;

/** A practice exam made through the web app: nothing is flagged. */
function seedPractice() {
  fake.put('batches', { batchId: 'practice', name: 'Practice batch' });
  fake.put('users', {
    email: 's1@college.edu',
    role: 'STUDENT',
    batchId: 'practice',
    rollNo: 'R1',
  });
  fake.put('users', {
    email: 's2@college.edu',
    role: 'STUDENT',
    batchId: 'practice',
    rollNo: 'R2',
  });
  fake.put('users', { email: 'mgr@college.edu', role: 'BATCH_MANAGER', batchId: 'practice' });
  fake.put('users', { email: 'founder@gmail.com', role: 'SUPER_ADMIN', batchId: 'practice' });
  fake.put('questions', { questionId: 'pq', version: 1 });
  fake.put('exams', {
    examId: 'practice-1',
    batchId: 'practice',
    questions: [{ questionId: 'pq', version: 1 }],
  });
  fake.put('examStudents', { examId: 'practice-1', studentEmail: 's1@college.edu' });
  fake.put('examStudents', { examId: 'practice-1', studentEmail: 's2@college.edu' });
  fake.put('answers', { examStudent: 'practice-1#s1@college.edu', questionNumber: 1 });
  fake.put('answers', { examStudent: 'practice-1#s1@college.edu', questionNumber: 2 });
  fake.put('answers', { examStudent: 'practice-1#s2@college.edu', questionNumber: 1 });
  // Real data in other exams must never be flagged.
  fake.put('exams', { examId: 'real-1', batchId: 'cse-a', questions: [] });
  fake.put('examStudents', { examId: 'real-1', studentEmail: 's1@college.edu' });
  fake.put('answers', { examStudent: 'real-1#s1@college.edu', questionNumber: 1 });
}

const flagged = (table: Parameters<typeof fake.all>[0]) =>
  fake.all(table).filter((r) => r['dev'] === true);

beforeEach(() => fake.reset());

describe('planMark', () => {
  it('without options, flags the exam, its exam rows and its answers only', async () => {
    seedPractice();

    const plan = await planMark(aws, 'practice-1', {});

    expect(plan.targets.map((t) => t.kind).sort()).toEqual([
      'answer',
      'answer',
      'answer',
      'exam',
      'exam row',
      'exam row',
    ]);
    expect(fake.writes).toEqual([]);
  });

  it('with --batch, adds the batch and its students, never staff', async () => {
    seedPractice();
    const plan = await planMark(aws, 'practice-1', { batch: true });
    expect(plan.targets.filter((t) => t.kind === 'batch').map((t) => t.label)).toEqual([
      'practice',
    ]);
    expect(plan.targets.filter((t) => t.kind === 'student').map((t) => t.key['email'])).toEqual([
      's1@college.edu',
      's2@college.edu',
    ]);
  });

  it('with --questions, adds the question versions the exam uses', async () => {
    seedPractice();
    const plan = await planMark(aws, 'practice-1', { questions: true });
    expect(plan.targets.filter((t) => t.kind === 'question').map((t) => t.label)).toEqual([
      'pq v1',
    ]);
  });

  it('counts what is already flagged and does not plan it again', async () => {
    seedPractice();
    fake.all('exams')[0]!['dev'] = true;
    const plan = await planMark(aws, 'practice-1', {});
    expect(plan.alreadyDev).toBe(1);
    expect(plan.targets.some((t) => t.kind === 'exam')).toBe(false);
  });

  it('warns when the batch has another exam that is not dev', async () => {
    seedPractice();
    fake.put('exams', { examId: 'other', batchId: 'practice', questions: [] });
    const plan = await planMark(aws, 'practice-1', { batch: true });
    expect(plan.notes.join(' ')).toMatch(/other/);
  });

  it('fails clearly for an exam that does not exist', async () => {
    await expect(planMark(aws, 'nope', {})).rejects.toThrow(/No exam nope/);
  });
});

describe('describePlan', () => {
  it('lists what will be flagged, by kind', async () => {
    seedPractice();
    const text = describePlan(
      await planMark(aws, 'practice-1', { batch: true, questions: true }),
    ).join('\n');
    expect(text).toContain('exams: 1');
    expect(text).toContain('answers: 3');
    expect(text).toContain('students: 2');
    expect(text).toContain('questions: 1');
  });
});

describe('applyMark', () => {
  it('flags the practice exam and nothing from the real data', async () => {
    seedPractice();

    const result = await applyMark(
      aws,
      await planMark(aws, 'practice-1', { batch: true, questions: true }),
    );

    expect(result).toEqual({ marked: 10, skipped: [] });
    expect(flagged('exams').map((e) => e['examId'])).toEqual(['practice-1']);
    expect(flagged('examStudents')).toHaveLength(2);
    expect(flagged('answers')).toHaveLength(3);
    expect(flagged('users').map((u) => u['email'])).toEqual(['s1@college.edu', 's2@college.edu']);
    expect(flagged('batches')).toHaveLength(1);
    expect(flagged('questions')).toHaveLength(1);
    // The real exam's rows and answers are untouched, and so are staff.
    expect(fake.all('examStudents').find((r) => r['examId'] === 'real-1')?.['dev']).toBeUndefined();
    expect(
      fake.all('answers').find((r) => String(r['examStudent']).startsWith('real-1'))?.['dev'],
    ).toBeUndefined();
    expect(fake.all('users').find((u) => u['role'] === 'BATCH_MANAGER')?.['dev']).toBeUndefined();
    expect(fake.all('users').find((u) => u['role'] === 'SUPER_ADMIN')?.['dev']).toBeUndefined();
  });

  it('only adds the flag, conditional on the item existing', async () => {
    seedPractice();
    await applyMark(aws, await planMark(aws, 'practice-1', {}));
    for (const w of fake.writes) {
      expect(w.input['UpdateExpression']).toBe('SET #dev = :true');
      expect(w.input['ConditionExpression']).toContain('attribute_exists(#pk)');
    }
  });

  it('flags a student only if they are still a student', async () => {
    seedPractice();
    const plan = await planMark(aws, 'practice-1', { batch: true });
    fake.all('users').find((u) => u['email'] === 's2@college.edu')!['role'] = 'TEACHER';

    const result = await applyMark(aws, plan);

    expect(result.skipped).toEqual(['student s2@college.edu (R2)']);
    expect(fake.all('users').find((u) => u['email'] === 's2@college.edu')?.['dev']).toBeUndefined();
  });

  it('can be run again: nothing is left to flag', async () => {
    seedPractice();
    await applyMark(aws, await planMark(aws, 'practice-1', { batch: true, questions: true }));
    const again = await planMark(aws, 'practice-1', { batch: true, questions: true });
    expect(again.targets).toEqual([]);
  });

  it('makes the practice data something cleanup can then remove, and only that', async () => {
    seedPractice();
    await applyMark(aws, await planMark(aws, 'practice-1', { batch: true, questions: true }));

    const plan = await planCleanup(aws);

    expect(plan.exams.map((e) => e.key['examId'])).toEqual(['practice-1']);
    expect(plan.answers).toHaveLength(3);
    expect(plan.students).toHaveLength(2);
    expect(plan.prefixes.sort()).toEqual([
      'answers/practice-1/',
      'exams/practice-1/',
      'questions/pq/v1/',
    ]);
    // The batch also has a manager and a founder who are not dev, so the batch stays.
    expect(plan.batches).toHaveLength(0);
    expect(plan.skipped.join(' ')).toMatch(/batch practice kept/);
  });
});

describe('the command', () => {
  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'mark-dev-data.ts', 'practice-1', '--yes'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
