// Removes dev data: everything that carries `dev: true` (the sample batch, student, questions and
// exam made by the e2e and seed scripts, and anything flagged with mark-dev-data.ts), with the
// exam rows, answers and appeals of the dev exams and the photo, paper and test files in S3.
//
// It NEVER touches an item without the flag: every delete is conditional on `dev = true`, super
// admins are never deleted, and the audit log is never touched. It always prints the list first.
// A dry run stops there; a real run needs --yes. A dev batch, question or exam that something
// without the flag still uses is kept and reported, and the exit code is then 1.
//
//   AWS_PROFILE=dsa-judge pnpm cleanup:dev-data --dry-run
//   AWS_PROFILE=dsa-judge pnpm cleanup:dev-data --yes
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { examStudentKey, mapLimit } from '@yulove/shared';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './args.js';
import {
  checkMode,
  connect,
  isDev,
  queryAll,
  requireProfile,
  scanAll,
  scanDev,
  section,
  type Aws,
  type RunMode,
} from './dev-data.js';

interface Doomed {
  table: string;
  key: Record<string, unknown>;
  label: string;
  /** Extra condition, besides dev = true. */
  onlyIf?: { expression: string; names: Record<string, string>; values: Record<string, unknown> };
}

export interface CleanupPlan {
  /** In the order they are deleted. */
  answers: Doomed[];
  examRows: Doomed[];
  appeals: Doomed[];
  exams: Doomed[];
  students: Doomed[];
  questions: Doomed[];
  batches: Doomed[];
  /** S3 prefixes whose every version is removed. Each ends in a slash. */
  prefixes: string[];
  /** Kept, with the reason. */
  skipped: string[];
}

const examPrefixes = (examId: string) => [`answers/${examId}/`, `exams/${examId}/`];
const questionPrefix = (questionId: string, version: number) =>
  `questions/${questionId}/v${version}/`;

/** Works out what would be removed. Reads only. */
export async function planCleanup(aws: Aws): Promise<CleanupPlan> {
  const { tables } = aws;
  const [users, batches, questions, exams, examRows, answers] = await Promise.all([
    scanDev(aws, tables.users),
    scanDev(aws, tables.batches),
    scanDev(aws, tables.questions),
    scanDev(aws, tables.exams),
    scanDev(aws, tables.examStudents),
    scanDev(aws, tables.answers),
  ]);

  const plan: CleanupPlan = {
    answers: [],
    examRows: [],
    appeals: [],
    exams: [],
    students: [],
    questions: [],
    batches: [],
    prefixes: [],
    skipped: [],
  };

  // Everything in the exams table is needed to see who uses a dev batch or question.
  const allExams = await scanAll(aws.ddb, { TableName: tables.exams });

  // --- exams: kept if anything without the flag still belongs to them
  const keptExams = new Set<string>();
  for (const exam of exams) {
    const examId = String(exam['examId']);
    const rows = await queryAll(aws.ddb, {
      TableName: tables.examStudents,
      KeyConditionExpression: 'examId = :examId',
      ExpressionAttributeValues: { ':examId': examId },
    });
    const unflagged: string[] = rows
      .filter((r) => !isDev(r))
      .map((r) => `exam row ${String(r['studentEmail'])}`);
    for (const row of rows) {
      const answersOfStudent = await queryAll(aws.ddb, {
        TableName: tables.answers,
        KeyConditionExpression: 'examStudent = :examStudent',
        ExpressionAttributeValues: {
          ':examStudent': examStudentKey(examId, String(row['studentEmail'])),
        },
      });
      for (const a of answersOfStudent.filter((x) => !isDev(x))) {
        unflagged.push(`answer ${String(row['studentEmail'])} q${String(a['questionNumber'])}`);
      }
    }
    if (unflagged.length > 0) {
      keptExams.add(examId);
      plan.skipped.push(
        `exam ${examId} kept: ${unflagged.length} things in it are not flagged dev (${unflagged.slice(0, 3).join(', ')}${unflagged.length > 3 ? ', ...' : ''}). Flag them with mark-dev-data or remove them in the app.`,
      );
      continue;
    }
    plan.exams.push({ table: tables.exams, key: { examId }, label: examId });
    plan.prefixes.push(...examPrefixes(examId));
    for (const appeal of await queryAll(aws.ddb, {
      TableName: tables.appeals,
      IndexName: 'byExam',
      KeyConditionExpression: 'examId = :examId',
      ExpressionAttributeValues: { ':examId': examId },
    })) {
      plan.appeals.push({
        table: tables.appeals,
        key: { appealId: String(appeal['appealId']) },
        label: `${String(appeal['appealId'])} (${String(appeal['studentEmail'])} q${String(appeal['questionNumber'])})`,
      });
    }
  }

  // --- exam rows and answers: flagged ones go, unless their exam is kept
  for (const row of examRows) {
    const examId = String(row['examId']);
    if (keptExams.has(examId)) continue;
    plan.examRows.push({
      table: tables.examStudents,
      key: { examId, studentEmail: String(row['studentEmail']) },
      label: `${examId} / ${String(row['studentEmail'])}`,
    });
  }
  for (const answer of answers) {
    const [examId] = String(answer['examStudent']).split('#');
    if (examId && keptExams.has(examId)) continue;
    plan.answers.push({
      table: tables.answers,
      key: {
        examStudent: String(answer['examStudent']),
        questionNumber: Number(answer['questionNumber']),
      },
      label: `${String(answer['examStudent'])} q${String(answer['questionNumber'])}`,
    });
  }

  // --- students: never a super admin; teachers and batch managers only if flagged
  for (const user of users) {
    const email = String(user['email']);
    if (user['role'] === 'SUPER_ADMIN') {
      plan.skipped.push(`user ${email} kept: a super admin is never deleted.`);
      continue;
    }
    plan.students.push({
      table: tables.users,
      key: { email },
      label: `${email} (${String(user['role'])})`,
      onlyIf: {
        expression: '#role <> :admin',
        names: { '#role': 'role' },
        values: { ':admin': 'SUPER_ADMIN' },
      },
    });
  }

  // --- questions: kept if an exam without the flag uses that version
  for (const question of questions) {
    const questionId = String(question['questionId']);
    const version = Number(question['version']);
    const users = allExams.filter(
      (e) =>
        !isDev(e) &&
        ((e['questions'] ?? []) as Array<{ questionId: string; version: number }>).some(
          (q) => q.questionId === questionId && q.version === version,
        ),
    );
    if (users.length > 0) {
      plan.skipped.push(
        `question ${questionId} v${version} kept: used by ${users.map((e) => String(e['examId'])).join(', ')}, which is not dev.`,
      );
      continue;
    }
    plan.questions.push({
      table: tables.questions,
      key: { questionId, version },
      label: `${questionId} v${version}`,
    });
    plan.prefixes.push(questionPrefix(questionId, version));
  }

  // --- batches: kept if a student or an exam without the flag is still in them
  const deletedStudents = new Set(plan.students.map((s) => String(s.key['email'])));
  for (const batch of batches) {
    const batchId = String(batch['batchId']);
    const members = (
      await queryAll(aws.ddb, {
        TableName: tables.users,
        IndexName: 'byBatch',
        KeyConditionExpression: 'batchId = :batchId',
        ExpressionAttributeValues: { ':batchId': batchId },
      })
    ).filter((u) => !deletedStudents.has(String(u['email'])));
    const keptExamsInBatch = allExams.filter(
      (e) => e['batchId'] === batchId && !plan.exams.some((d) => d.key['examId'] === e['examId']),
    );
    if (members.length > 0 || keptExamsInBatch.length > 0) {
      plan.skipped.push(
        `batch ${batchId} kept: ${members.length} users and ${keptExamsInBatch.length} exams in it are staying.`,
      );
      continue;
    }
    plan.batches.push({ table: tables.batches, key: { batchId }, label: batchId });
  }
  return plan;
}

export function describePlan(plan: CleanupPlan): string[] {
  const lines = ['Will delete (only items flagged dev):'];
  const groups: Array<[string, Doomed[]]> = [
    ['answers', plan.answers],
    ['exam rows', plan.examRows],
    ['appeals of those exams', plan.appeals],
    ['exams', plan.exams],
    ['users', plan.students],
    ['questions', plan.questions],
    ['batches', plan.batches],
  ];
  for (const [title, items] of groups) {
    lines.push(
      ...section(
        title,
        items.map((i) => i.label),
      ),
    );
  }
  lines.push(...section('S3 folders (every version of every file in them)', plan.prefixes));
  if (plan.skipped.length > 0) {
    lines.push('Kept:', ...plan.skipped.map((s) => `    ${s}`));
  }
  lines.push('The audit log is never touched.');
  return lines;
}

export function isEmpty(plan: CleanupPlan): boolean {
  return (
    plan.prefixes.length === 0 &&
    [
      plan.answers,
      plan.examRows,
      plan.appeals,
      plan.exams,
      plan.students,
      plan.questions,
      plan.batches,
    ].every((g) => g.length === 0)
  );
}

export interface CleanupResult {
  deleted: number;
  s3Versions: number;
  /** No longer flagged (or gone) when the delete was tried; left alone. */
  changed: string[];
}

/** Deletes every version and delete marker under a prefix. Returns how many were removed. */
export async function emptyPrefix(aws: Aws, prefix: string): Promise<number> {
  if (!prefix.endsWith('/') || prefix === '/') throw new Error(`Refusing to empty "${prefix}".`);
  let removed = 0;
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page = await aws.s3.send(
      new ListObjectVersionsCommand({
        Bucket: aws.bucket,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
      }),
    );
    const targets: ObjectIdentifier[] = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((o) => o.Key?.startsWith(prefix))
      .map((o) => ({ Key: o.Key as string, ...(o.VersionId ? { VersionId: o.VersionId } : {}) }));
    for (let i = 0; i < targets.length; i += 1000) {
      const batch = targets.slice(i, i + 1000);
      const out = await aws.s3.send(
        new DeleteObjectsCommand({ Bucket: aws.bucket, Delete: { Objects: batch, Quiet: true } }),
      );
      if ((out.Errors ?? []).length > 0) {
        throw new Error(
          `S3 would not delete ${(out.Errors ?? []).length} files under ${prefix}: ${out.Errors?.[0]?.Message ?? 'unknown error'}`,
        );
      }
      removed += batch.length;
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionMarker);
  return removed;
}

/** Does the deleting: S3 files first, then the rows. Safe to run again. */
export async function applyCleanup(aws: Aws, plan: CleanupPlan): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, s3Versions: 0, changed: [] };

  for (const prefix of plan.prefixes) result.s3Versions += await emptyPrefix(aws, prefix);

  const order = [
    plan.answers,
    plan.examRows,
    plan.appeals,
    plan.exams,
    plan.students,
    plan.questions,
    plan.batches,
  ];
  for (const group of order) {
    await mapLimit(group, 10, async (doomed: Doomed) => {
      const [pk] = Object.keys(doomed.key);
      try {
        await aws.ddb.send(
          new DeleteCommand({
            TableName: doomed.table,
            Key: doomed.key,
            // Appeals have no flag of their own; they go only with a deleted dev exam (see planCleanup).
            ConditionExpression:
              doomed.table === aws.tables.appeals
                ? 'attribute_exists(#pk)'
                : `#dev = :true AND attribute_exists(#pk)${doomed.onlyIf ? ` AND ${doomed.onlyIf.expression}` : ''}`,
            ExpressionAttributeNames: {
              '#pk': pk as string,
              ...(doomed.table === aws.tables.appeals ? {} : { '#dev': 'dev' }),
              ...(doomed.onlyIf?.names ?? {}),
            },
            ...(doomed.table === aws.tables.appeals
              ? {}
              : { ExpressionAttributeValues: { ':true': true, ...(doomed.onlyIf?.values ?? {}) } }),
          }),
        );
        result.deleted += 1;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        result.changed.push(`${doomed.table} ${doomed.label}`);
      }
    });
  }
  return result;
}

async function main(argv: string[]): Promise<void> {
  const profile = requireProfile('pnpm cleanup:dev-data --dry-run');
  const { values } = parseFlags(argv, { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' } });
  const mode: RunMode = { dryRun: values['dry-run'] === true, yes: values.yes === true };

  const aws = await connect();
  console.log(`Profile ${profile}${mode.dryRun ? ' (dry run)' : ''}.`);
  const plan = await planCleanup(aws);
  for (const line of describePlan(plan)) console.log(line);
  if (plan.skipped.length > 0) process.exitCode = 1;

  if (isEmpty(plan)) {
    console.log('There is no dev data to delete.');
    return;
  }
  if (checkMode(mode, 'pnpm cleanup:dev-data --yes') === 'dry-run') {
    console.log('Dry run: nothing was deleted.');
    return;
  }
  const result = await applyCleanup(aws, plan);
  console.log(`Deleted ${result.deleted} rows and ${result.s3Versions} stored file versions.`);
  if (result.changed.length > 0) {
    console.log(`Left alone because they were no longer flagged dev: ${result.changed.join(', ')}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
