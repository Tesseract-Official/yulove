import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCleanup,
  describePlan,
  emptyPrefix,
  isEmpty,
  planCleanup,
} from './cleanup-dev-data.js';
import { checkMode } from './dev-data.js';
import { FakeAws } from './dev-data.test-support.js';

const fake = new FakeAws();
const aws = fake.aws;

const devExam = {
  examId: 'dev-exam',
  batchId: 'dev-batch',
  questions: [{ questionId: 'dev-q', version: 1 }],
  dev: true,
};

/** The dev world the e2e script makes. */
function seedDev() {
  fake.put('batches', { batchId: 'dev-batch', name: 'Dev batch', dev: true });
  fake.put('users', {
    email: 'dev-student@college.edu',
    role: 'STUDENT',
    batchId: 'dev-batch',
    dev: true,
  });
  fake.put('questions', { questionId: 'dev-q', version: 1, dev: true });
  fake.put('exams', devExam);
  fake.put('examStudents', {
    examId: 'dev-exam',
    studentEmail: 'dev-student@college.edu',
    dev: true,
  });
  fake.put('answers', {
    examStudent: 'dev-exam#dev-student@college.edu',
    questionNumber: 1,
    dev: true,
  });
  fake.put('appeals', {
    appealId: 'ap-1',
    examId: 'dev-exam',
    studentEmail: 'dev-student@college.edu',
    questionNumber: 1,
  });
  fake.objects.push(
    { Key: 'answers/dev-exam/R1/q1.jpg', VersionId: 'v1' },
    { Key: 'answers/dev-exam/R1/q1.jpg', VersionId: 'v2' },
    { Key: 'exams/dev-exam/paper.pdf', VersionId: 'v1' },
    { Key: 'questions/dev-q/v1/tests.json', VersionId: 'v1' },
    { Key: 'questions/dev-q/v1/tests.json', VersionId: 'm1', deleteMarker: true },
  );
}

/** Real data that must survive everything. */
function seedReal() {
  fake.put('batches', { batchId: 'cse-a', name: 'CSE A' });
  fake.put('users', { email: 'real@college.edu', role: 'STUDENT', batchId: 'cse-a' });
  fake.put('users', { email: 'founder@gmail.com', role: 'SUPER_ADMIN', name: 'Founder' });
  fake.put('questions', { questionId: 'real-q', version: 1 });
  fake.put('exams', {
    examId: 'real-exam',
    batchId: 'cse-a',
    questions: [{ questionId: 'real-q', version: 1 }],
  });
  fake.put('examStudents', { examId: 'real-exam', studentEmail: 'real@college.edu' });
  fake.put('answers', { examStudent: 'real-exam#real@college.edu', questionNumber: 1 });
  fake.objects.push(
    { Key: 'answers/real-exam/R9/q1.jpg', VersionId: 'v1' },
    { Key: 'questions/real-q/v1/tests.json', VersionId: 'v1' },
    { Key: 'questions/dev-q-but-not/v1/tests.json', VersionId: 'v1' },
  );
}

beforeEach(() => fake.reset());

describe('planCleanup', () => {
  it('lists the dev world, including the appeals of the dev exam and its S3 folders', async () => {
    seedDev();
    seedReal();

    const plan = await planCleanup(aws);

    expect(plan.answers.map((a) => a.label)).toEqual(['dev-exam#dev-student@college.edu q1']);
    expect(plan.examRows).toHaveLength(1);
    expect(plan.appeals.map((a) => a.key)).toEqual([{ appealId: 'ap-1' }]);
    expect(plan.exams.map((e) => e.key)).toEqual([{ examId: 'dev-exam' }]);
    expect(plan.students.map((s) => s.key)).toEqual([{ email: 'dev-student@college.edu' }]);
    expect(plan.questions.map((q) => q.key)).toEqual([{ questionId: 'dev-q', version: 1 }]);
    expect(plan.batches.map((b) => b.key)).toEqual([{ batchId: 'dev-batch' }]);
    expect(plan.prefixes.sort()).toEqual([
      'answers/dev-exam/',
      'exams/dev-exam/',
      'questions/dev-q/v1/',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('never lists an item without the flag, even if the server returned it', async () => {
    seedReal();
    const plan = await planCleanup(aws);
    expect(isEmpty(plan)).toBe(true);
  });

  it('reads only: it writes nothing', async () => {
    seedDev();
    await planCleanup(aws);
    expect(fake.writes).toEqual([]);
  });

  it('never deletes a super admin, even one flagged dev, and says so', async () => {
    fake.put('users', { email: 'founder@gmail.com', role: 'SUPER_ADMIN', dev: true });
    const plan = await planCleanup(aws);
    expect(plan.students).toEqual([]);
    expect(plan.skipped.join(' ')).toMatch(/super admin is never deleted/);
  });

  it('keeps a dev question that an exam without the flag uses', async () => {
    seedDev();
    fake.put('exams', {
      examId: 'real-exam',
      batchId: 'cse-a',
      questions: [{ questionId: 'dev-q', version: 1 }],
    });

    const plan = await planCleanup(aws);

    expect(plan.questions).toEqual([]);
    expect(plan.prefixes).not.toContain('questions/dev-q/v1/');
    expect(plan.skipped.join(' ')).toMatch(/question dev-q v1 kept: used by real-exam/);
  });

  it('keeps a dev batch that a student without the flag is in', async () => {
    seedDev();
    fake.put('users', { email: 'real@college.edu', role: 'STUDENT', batchId: 'dev-batch' });

    const plan = await planCleanup(aws);

    expect(plan.batches).toEqual([]);
    expect(plan.skipped.join(' ')).toMatch(/batch dev-batch kept: 1 users/);
  });

  it('keeps a dev batch that still has an exam without the flag', async () => {
    seedDev();
    fake.put('exams', { examId: 'real-exam', batchId: 'dev-batch', questions: [] });

    const plan = await planCleanup(aws);

    expect(plan.batches).toEqual([]);
    expect(plan.skipped.join(' ')).toMatch(/1 exams/);
  });

  it('keeps a dev exam, with its rows, answers and files, when unflagged answers are in it', async () => {
    seedDev();
    fake.put('answers', { examStudent: 'dev-exam#dev-student@college.edu', questionNumber: 2 });

    const plan = await planCleanup(aws);

    expect(plan.exams).toEqual([]);
    expect(plan.answers).toEqual([]);
    expect(plan.examRows).toEqual([]);
    expect(plan.appeals).toEqual([]);
    expect(plan.prefixes).toEqual(['questions/dev-q/v1/']);
    expect(plan.skipped.join(' ')).toMatch(
      /exam dev-exam kept: 1 things in it are not flagged dev/,
    );
  });

  it('keeps a dev exam that has an exam row without the flag', async () => {
    seedDev();
    fake.put('examStudents', { examId: 'dev-exam', studentEmail: 'real@college.edu' });
    const plan = await planCleanup(aws);
    expect(plan.exams).toEqual([]);
  });
});

describe('describePlan', () => {
  it('shows every group with counts, the S3 folders and what is kept', async () => {
    seedDev();
    fake.put('users', { email: 'real@college.edu', role: 'STUDENT', batchId: 'dev-batch' });
    const text = describePlan(await planCleanup(aws)).join('\n');

    expect(text).toContain('answers: 1');
    expect(text).toContain('appeals of those exams: 1');
    expect(text).toContain('S3 folders (every version of every file in them): 3');
    expect(text).toContain('answers/dev-exam/');
    expect(text).toContain('Kept:');
    expect(text).toContain('The audit log is never touched.');
  });

  it('cuts a long list short', async () => {
    for (let i = 0; i < 40; i += 1) {
      fake.put('answers', {
        examStudent: `dev-exam#s${i}@college.edu`,
        questionNumber: 1,
        dev: true,
      });
    }
    const text = describePlan(await planCleanup(aws)).join('\n');
    expect(text).toContain('answers: 40');
    expect(text).toContain('... and 25 more');
  });
});

describe('applyCleanup', () => {
  it('deletes the dev world and leaves the real one exactly as it was', async () => {
    seedDev();
    seedReal();
    const realRows = structuredClone(fake.rows);
    for (const table of Object.keys(realRows)) {
      realRows[table] = (realRows[table] ?? []).filter(
        (r) => r['dev'] !== true && r['appealId'] === undefined,
      );
    }

    const result = await applyCleanup(aws, await planCleanup(aws));

    expect(result.changed).toEqual([]);
    expect(result.deleted).toBe(7); // answer, exam row, appeal, exam, student, question, batch
    for (const table of Object.keys(realRows)) {
      expect(fake.rows[table], table).toEqual(realRows[table]);
    }
    expect(fake.objects.map((o) => o.Key).sort()).toEqual([
      'answers/real-exam/R9/q1.jpg',
      'questions/dev-q-but-not/v1/tests.json',
      'questions/real-q/v1/tests.json',
    ]);
    expect(result.s3Versions).toBe(5);
  });

  it('deletes only with a condition on the flag (and never a super admin), so a race cannot remove real data', async () => {
    seedDev();
    await applyCleanup(aws, await planCleanup(aws));

    const deletes = fake.writes.filter((w) => w.command === 'delete');
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes.filter((x) => x.table !== 'Appeals')) {
      expect(d.input['ConditionExpression'], `${String(d.table)}`).toContain('#dev = :true');
    }
    const userDelete = deletes.find((d) => d.table === 'Users');
    expect(userDelete?.input['ConditionExpression']).toContain('#role <> :admin');
  });

  it('leaves an item alone that lost its flag between the list and the delete', async () => {
    seedDev();
    const plan = await planCleanup(aws);
    const row = fake.all('users').find((u) => u['email'] === 'dev-student@college.edu') as Record<
      string,
      unknown
    >;
    delete row['dev'];

    const result = await applyCleanup(aws, plan);

    expect(result.changed).toEqual(['Users dev-student@college.edu (STUDENT)']);
    expect(fake.all('users')).toHaveLength(1);
  });

  it('removes S3 files before the rows', async () => {
    seedDev();
    await applyCleanup(aws, await planCleanup(aws));
    const order = fake.writes.map((w) => w.command);
    expect(order.indexOf('s3-delete')).toBeLessThan(order.indexOf('delete'));
  });

  it('is safe to run again', async () => {
    seedDev();
    await applyCleanup(aws, await planCleanup(aws));
    const second = await planCleanup(aws);
    expect(isEmpty(second)).toBe(true);
  });
});

describe('emptyPrefix', () => {
  it('removes every version and delete marker, 1000 at a time, across pages', async () => {
    for (let i = 0; i < 2500; i += 1)
      fake.objects.push({ Key: `answers/e/R${String(i).padStart(5, '0')}/q1.jpg`, VersionId: 'v' });
    fake.objects.push({ Key: 'answers/e2/other.jpg', VersionId: 'v' });
    fake.pageSize = 1000;

    const removed = await emptyPrefix(aws, 'answers/e/');

    expect(removed).toBe(2500);
    expect(fake.objects.map((o) => o.Key)).toEqual(['answers/e2/other.jpg']);
    const sizes = fake.writes
      .filter((w) => w.command === 's3-delete')
      .map((w) => (w.input['Delete'] as { Objects: unknown[] }).Objects.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
  });

  it('does not mix up q1 with q10', async () => {
    fake.objects.push(
      { Key: 'questions/q1/v1/a', VersionId: 'v' },
      { Key: 'questions/q10/v1/a', VersionId: 'v' },
    );
    await emptyPrefix(aws, 'questions/q1/');
    expect(fake.objects.map((o) => o.Key)).toEqual(['questions/q10/v1/a']);
  });

  it.each(['', '/', 'answers', 'answers/e'])('refuses the prefix %j', async (prefix) => {
    await expect(emptyPrefix(aws, prefix)).rejects.toThrow(/Refusing/);
  });

  it('stops with an error if S3 refuses a delete', async () => {
    fake.objects.push({ Key: 'answers/e/a.jpg', VersionId: 'v' });
    fake.s3Mock
      .on(DeleteObjectsCommand)
      .resolves({ Errors: [{ Key: 'answers/e/a.jpg', Message: 'Access Denied' }] });
    await expect(emptyPrefix(aws, 'answers/e/')).rejects.toThrow(/Access Denied/);
  });
});

describe('checkMode', () => {
  it('stops at the list on a dry run', () => {
    expect(checkMode({ dryRun: true, yes: false }, 'cmd')).toBe('dry-run');
    expect(checkMode({ dryRun: true, yes: true }, 'cmd')).toBe('dry-run');
  });

  it('refuses a real run without --yes, and says what to type', () => {
    expect(() => checkMode({ dryRun: false, yes: false }, 'pnpm cleanup:dev-data --yes')).toThrow(
      /Nothing was changed.*--yes/,
    );
  });

  it('goes ahead with --yes', () => {
    expect(checkMode({ dryRun: false, yes: true }, 'cmd')).toBe('go');
  });
});

describe('the command', () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync('pnpm', ['exec', 'tsx', 'cleanup-dev-data.ts', ...args], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });

  it('refuses to start without AWS_PROFILE', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = run(['--yes'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});
