// Writes two sample questions straight into the Questions table so transcription can be tried
// before any real question exists. They are marked `dev: true`, look approved, and are owned by
// the first founder. Existing items are never overwritten.
//
//   AWS_PROFILE=dsa-judge pnpm seed:dev-questions
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { QuestionItem } from '@yulove/shared';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_STACK, REGION } from './seed-super-admins.js';
import { stackOutputs } from './smoke-worker.js';

export const DEV_TEACHER = 'meloovegupta@gmail.com';

const common = {
  version: 1,
  teacherEmail: DEV_TEACHER,
  targetComplexity: 'O(n)',
  timeLimitMs: 2000,
  memoryMb: 256,
  compareMode: 'EXACT',
  // Looks approved so it can be used in an exam. No tests.json exists for it in S3.
  testStatus: 'APPROVED',
  testAttempt: 1,
  testCount: 10,
  dev: true,
} as const satisfies Partial<QuestionItem>;

/** The sample questions. Fixed ids, so running the script again changes nothing. */
export const DEV_QUESTIONS: readonly QuestionItem[] = [
  {
    ...common,
    questionId: 'dev-sum-array',
    title: 'Sum of array',
    statement: 'Given an array of integers, return the sum of all its elements.',
    ioDescription: 'Input: nums, a list of integers. Output: one integer, the sum of the elements.',
    constraints: '1 <= nums.length <= 100000; -10^4 <= nums[i] <= 10^4',
    examples: [
      { input: '{"nums": [1, 2, 3, 4]}', output: '10', explanation: '1 + 2 + 3 + 4 = 10' },
    ],
    signature: {
      name: 'sumArray',
      parameters: [{ name: 'nums', type: 'int[]' }],
      returnType: 'int',
    },
  },
  {
    ...common,
    questionId: 'dev-reverse-string',
    title: 'Reverse a string',
    statement: 'Given a string, return the string written backwards.',
    ioDescription: 'Input: s, a string. Output: the characters of s in reverse order.',
    constraints: '0 <= s.length <= 100000; s has printable ASCII characters only',
    examples: [{ input: '{"s": "hello"}', output: '"olleh"', explanation: 'h-e-l-l-o reversed' }],
    signature: {
      name: 'reverseString',
      parameters: [{ name: 's', type: 'string' }],
      returnType: 'string',
    },
  },
];

export interface DevSeedOutcome {
  questionId: string;
  status: 'created' | 'already-exists';
}

/** Adds each sample question that is not there yet. Never overwrites or changes anything else. */
export async function seedDevQuestions(
  client: DynamoDBDocumentClient,
  table: string,
  questions: readonly QuestionItem[] = DEV_QUESTIONS,
): Promise<DevSeedOutcome[]> {
  const outcomes: DevSeedOutcome[] = [];
  for (const question of questions) {
    try {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: question,
          // The key is questionId + version; either part missing means the version is new.
          ConditionExpression: 'attribute_not_exists(questionId)',
        }),
      );
      outcomes.push({ questionId: question.questionId, status: 'created' });
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      outcomes.push({ questionId: question.questionId, status: 'already-exists' });
    }
  }
  return outcomes;
}

async function main(): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error('Set AWS_PROFILE, e.g. AWS_PROFILE=dsa-judge pnpm seed:dev-questions');
  }
  const outputs = await stackOutputs(new CloudFormationClient({ region: REGION }), DATA_STACK);
  const table = outputs['QuestionsTableName'];
  if (!table) throw new Error(`Stack ${DATA_STACK} has no output QuestionsTableName.`);

  console.log(`Profile ${profile}, table ${table}.`);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  for (const { questionId, status } of await seedDevQuestions(client, table)) {
    const title = DEV_QUESTIONS.find((q) => q.questionId === questionId)?.title;
    console.log(
      `${status === 'created' ? 'Added' : 'Already there, left alone:'} ${questionId} v1 "${title}"`,
    );
  }
  console.log('Use these ids with: pnpm try:transcribe <photo.jpg> <questionId>');
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
