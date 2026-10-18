// Flags a practice exam as dev data, so that cleanup-dev-data.ts can remove it later. A practice
// exam made through the web app has no dev flag, and cleanup never touches anything without it.
//
// It flags the exam, its exam rows and its answers. With --batch it also flags the exam's batch and
// the students of that batch (never teachers, batch managers or super admins). With --questions it
// also flags the question versions the exam uses. It only ever ADDS the flag, and it always shows
// the list first.
//
//   AWS_PROFILE=dsa-judge pnpm mark:dev-data <examId> --batch --questions --dry-run
//   AWS_PROFILE=dsa-judge pnpm mark:dev-data <examId> --batch --questions --yes
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  section,
  type Aws,
  type Item,
  type RunMode,
} from './dev-data.js';

export interface MarkOptions {
  batch?: boolean;
  questions?: boolean;
}

export interface Target {
  kind: 'exam' | 'exam row' | 'answer' | 'batch' | 'student' | 'question';
  label: string;
  table: string;
  key: Record<string, unknown>;
  /** Extra condition on the item, besides it existing. */
  onlyIf?: { expression: string; names: Record<string, string>; values: Record<string, unknown> };
}

export interface MarkPlan {
  examId: string;
  /** Items that will get the flag. */
  targets: Target[];
  /** Items that already have it. */
  alreadyDev: number;
  notes: string[];
}

/** Works out what would be flagged. Reads only. */
export async function planMark(aws: Aws, examId: string, options: MarkOptions): Promise<MarkPlan> {
  const { Item: exam } = await aws.ddb.send(
    new GetCommand({ TableName: aws.tables.exams, Key: { examId } }),
  );
  if (!exam)
    throw new Error(`No exam ${examId}. Check the id on the Teacher or Batch manager screen.`);

  const plan: MarkPlan = { examId, targets: [], alreadyDev: 0, notes: [] };
  const add = (found: Item | undefined, target: Target) => {
    if (isDev(found)) plan.alreadyDev += 1;
    else plan.targets.push(target);
  };

  add(exam, { kind: 'exam', label: examId, table: aws.tables.exams, key: { examId } });

  const rows = await queryAll(aws.ddb, {
    TableName: aws.tables.examStudents,
    KeyConditionExpression: 'examId = :examId',
    ExpressionAttributeValues: { ':examId': examId },
  });
  for (const row of rows) {
    const studentEmail = String(row['studentEmail']);
    add(row, {
      kind: 'exam row',
      label: studentEmail,
      table: aws.tables.examStudents,
      key: { examId, studentEmail },
    });
    const answers = await queryAll(aws.ddb, {
      TableName: aws.tables.answers,
      KeyConditionExpression: 'examStudent = :examStudent',
      ExpressionAttributeValues: { ':examStudent': examStudentKey(examId, studentEmail) },
    });
    for (const answer of answers) {
      const questionNumber = Number(answer['questionNumber']);
      add(answer, {
        kind: 'answer',
        label: `${studentEmail} q${questionNumber}`,
        table: aws.tables.answers,
        key: { examStudent: examStudentKey(examId, studentEmail), questionNumber },
      });
    }
  }

  if (options.questions) {
    const refs = (exam['questions'] ?? []) as Array<{ questionId: string; version: number }>;
    for (const { questionId, version } of refs) {
      const { Item: question } = await aws.ddb.send(
        new GetCommand({ TableName: aws.tables.questions, Key: { questionId, version } }),
      );
      if (!question) {
        plan.notes.push(`Question ${questionId} v${version} does not exist; skipped.`);
        continue;
      }
      add(question, {
        kind: 'question',
        label: `${questionId} v${version}`,
        table: aws.tables.questions,
        key: { questionId, version },
      });
    }
  }

  if (options.batch) {
    const batchId = String(exam['batchId']);
    const { Item: batch } = await aws.ddb.send(
      new GetCommand({ TableName: aws.tables.batches, Key: { batchId } }),
    );
    if (batch) {
      add(batch, { kind: 'batch', label: batchId, table: aws.tables.batches, key: { batchId } });
    }
    const users = await queryAll(aws.ddb, {
      TableName: aws.tables.users,
      IndexName: 'byBatch',
      KeyConditionExpression: 'batchId = :batchId',
      ExpressionAttributeValues: { ':batchId': batchId },
    });
    for (const user of users.filter((u) => u['role'] === 'STUDENT')) {
      const email = String(user['email']);
      add(user, {
        kind: 'student',
        label: `${email} (${String(user['rollNo'] ?? 'no roll number')})`,
        table: aws.tables.users,
        key: { email },
        // Only students: a teacher, batch manager or super admin is never flagged by this script.
        onlyIf: {
          expression: '#role = :student',
          names: { '#role': 'role' },
          values: { ':student': 'STUDENT' },
        },
      });
    }
    const exams = await queryAll(aws.ddb, {
      TableName: aws.tables.exams,
      IndexName: 'byBatch',
      KeyConditionExpression: 'batchId = :batchId',
      ExpressionAttributeValues: { ':batchId': batchId },
    });
    const others = exams.filter((e) => e['examId'] !== examId && !isDev(e));
    if (others.length > 0) {
      plan.notes.push(
        `The batch also has exams that are not dev (${others.map((e) => String(e['examId'])).join(', ')}). Cleanup will keep the batch until they are gone.`,
      );
    }
  }
  return plan;
}

export function describePlan(plan: MarkPlan): string[] {
  const kinds: Target['kind'][] = ['exam', 'exam row', 'answer', 'batch', 'student', 'question'];
  const lines = [`Will flag as dev, for exam ${plan.examId}:`];
  for (const kind of kinds) {
    const mine = plan.targets.filter((t) => t.kind === kind);
    if (mine.length > 0)
      lines.push(
        ...section(
          `${kind}s`,
          mine.map((t) => t.label),
        ),
      );
  }
  if (plan.targets.length === 0) lines.push('  nothing: everything is already flagged.');
  if (plan.alreadyDev > 0) lines.push(`  ${plan.alreadyDev} items already have the flag.`);
  for (const note of plan.notes) lines.push(`  Note: ${note}`);
  return lines;
}

export interface MarkResult {
  marked: number;
  /** Gone, or no longer what was expected, between the plan and the change. */
  skipped: string[];
}

/** Adds dev = true to each planned item, and changes nothing else. */
export async function applyMark(aws: Aws, plan: MarkPlan): Promise<MarkResult> {
  const result: MarkResult = { marked: 0, skipped: [] };
  await mapLimit(plan.targets, 10, async (target) => {
    const [pk] = Object.keys(target.key);
    try {
      await aws.ddb.send(
        new UpdateCommand({
          TableName: target.table,
          Key: target.key,
          UpdateExpression: 'SET #dev = :true',
          ConditionExpression: `attribute_exists(#pk)${target.onlyIf ? ` AND ${target.onlyIf.expression}` : ''}`,
          ExpressionAttributeNames: {
            '#dev': 'dev',
            '#pk': pk as string,
            ...(target.onlyIf?.names ?? {}),
          },
          ExpressionAttributeValues: { ':true': true, ...(target.onlyIf?.values ?? {}) },
        }),
      );
      result.marked += 1;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      result.skipped.push(`${target.kind} ${target.label}`);
    }
  });
  return result;
}

async function main(argv: string[]): Promise<void> {
  const profile = requireProfile('pnpm mark:dev-data <examId> --batch --questions --dry-run');
  const { values, positionals } = parseFlags(
    argv,
    {
      batch: { type: 'boolean' },
      questions: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    true,
  );
  const [examId, ...extra] = positionals;
  if (!examId || extra.length > 0) {
    throw new Error(
      'Usage: AWS_PROFILE=dsa-judge pnpm mark:dev-data <examId> [--batch] [--questions] (--dry-run | --yes)',
    );
  }
  const mode: RunMode = { dryRun: values['dry-run'] === true, yes: values.yes === true };

  const aws = await connect();
  console.log(`Profile ${profile}${mode.dryRun ? ' (dry run)' : ''}.`);
  const plan = await planMark(aws, examId, {
    batch: values.batch === true,
    questions: values.questions === true,
  });
  for (const line of describePlan(plan)) console.log(line);

  if (checkMode(mode, 'pnpm mark:dev-data <examId> ...') === 'dry-run') {
    console.log('Dry run: nothing was changed.');
    return;
  }
  const result = await applyMark(aws, plan);
  console.log(`Flagged ${result.marked} items as dev.`);
  if (result.skipped.length > 0) {
    console.log(`Skipped (changed or gone since the list): ${result.skipped.join(', ')}`);
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
