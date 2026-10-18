// One-off: gives every existing answer the attributes of the Answers `byExam` index (examId,
// studentEmail, examSort), which new answers get when they are created. Without them an answer is
// missing from the status board, the results and publish. Safe to run again: it only touches
// answers that lack `examSort`, and never overwrites anything else.
//
//   AWS_PROFILE=dsa-judge pnpm backfill:answers-exam-index --dry-run
//   AWS_PROFILE=dsa-judge pnpm backfill:answers-exam-index
//
// Deploy order: deploy DsaJudgeData (it adds the index), run this, deploy the rest, run it again.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { answerIndexKeys, mapLimit, parseExamStudentKey } from '@yulove/shared';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './args.js';
import { DATA_STACK, REGION } from './seed-super-admins.js';
import { stackOutputs } from './smoke-worker.js';

export const ANSWERS_TABLE_OUTPUT = 'AnswersTableName';

export interface BackfillResult {
  scanned: number;
  /** Already had the index attributes. */
  alreadyIndexed: number;
  /** Given them now (or that would be, in a dry run). */
  updated: number;
  /** Got them from another run between the scan and the update. */
  raced: number;
  /** Partition keys that are not `examId#studentEmail`; left alone. */
  malformed: string[];
}

export interface BackfillOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** Scans the Answers table and adds the index attributes to every answer that lacks them. */
export async function backfillAnswersExamIndex(
  client: DynamoDBDocumentClient,
  table: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const log = options.log ?? (() => undefined);
  const result: BackfillResult = {
    scanned: 0,
    alreadyIndexed: 0,
    updated: 0,
    raced: 0,
    malformed: [],
  };

  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: 'examStudent, questionNumber, examSort',
        ExclusiveStartKey: startKey,
      }),
    );
    const items = (page.Items ?? []) as Array<{
      examStudent: string;
      questionNumber: number;
      examSort?: string;
    }>;
    result.scanned += items.length;

    await mapLimit(items, 10, async (item) => {
      if (item.examSort !== undefined) {
        result.alreadyIndexed += 1;
        return;
      }
      const parts = parseExamStudentKey(item.examStudent);
      if (!parts) {
        result.malformed.push(item.examStudent);
        return;
      }
      if (options.dryRun) {
        result.updated += 1;
        return;
      }
      const keys = answerIndexKeys(parts.examId, parts.studentEmail, item.questionNumber);
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { examStudent: item.examStudent, questionNumber: item.questionNumber },
            UpdateExpression:
              'SET examId = :examId, studentEmail = :studentEmail, examSort = :examSort',
            ConditionExpression: 'attribute_exists(examStudent) AND attribute_not_exists(examSort)',
            ExpressionAttributeValues: {
              ':examId': keys.examId,
              ':studentEmail': keys.studentEmail,
              ':examSort': keys.examSort,
            },
          }),
        );
        result.updated += 1;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        result.raced += 1;
      }
    });

    startKey = page.LastEvaluatedKey;
    log(`Scanned ${result.scanned} answers so far...`);
  } while (startKey);

  return result;
}

export function describeResult(result: BackfillResult, dryRun: boolean): string[] {
  return [
    `Scanned ${result.scanned} answers.`,
    `${result.alreadyIndexed} already had the index attributes.`,
    `${result.updated} ${dryRun ? 'would be updated (dry run, nothing written)' : 'updated'}.`,
    ...(result.raced > 0 ? [`${result.raced} were updated by someone else meanwhile.`] : []),
    ...(result.malformed.length > 0
      ? [
          `${result.malformed.length} had an unexpected key and were left alone: ${result.malformed.join(', ')}`,
        ]
      : []),
  ];
}

async function main(argv: string[]): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error(
      'Set AWS_PROFILE to the AWS profile to use, e.g. AWS_PROFILE=dsa pnpm backfill:answers-exam-index --dry-run',
    );
  }
  const { values } = parseFlags(argv, { 'dry-run': { type: 'boolean' } });
  const dryRun = values['dry-run'] === true;

  const outputs = await stackOutputs(new CloudFormationClient({ region: REGION }), DATA_STACK);
  const table = outputs[ANSWERS_TABLE_OUTPUT];
  if (!table)
    throw new Error(`Stack ${DATA_STACK} has no output ${ANSWERS_TABLE_OUTPUT}. Is it deployed?`);

  console.log(`Profile ${profile}, table ${table}${dryRun ? ' (dry run)' : ''}.`);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const result = await backfillAnswersExamIndex(client, table, { dryRun, log: console.log });
  for (const line of describeResult(result, dryRun)) console.log(line);
  if (result.malformed.length > 0) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
