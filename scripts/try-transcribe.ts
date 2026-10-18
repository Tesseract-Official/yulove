// Tries the transcription on one photographed answer with the REAL Gemini API, using the deployed
// API key, and shows what the Transcribe Lambda would do with the reply. It reads AWS and calls
// Gemini; it writes nothing to AWS. This is the only script that may call the real API.
//
//   AWS_PROFILE=dsa-judge pnpm try:transcribe <imagePath> <questionId> [version]
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ANSWER_IMAGE_MAX_BYTES, type QuestionItem } from '@yulove/shared';
import {
  buildTranscribePrompt,
  createGeminiClient,
  formatAttempt,
  loadPromptFile,
  transcribeImage,
  type GeminiClient,
  type TranscriptionVerdict,
} from '@yulove/pipeline/transcribe';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_STACK, REGION } from './seed-super-admins.js';
import { stackOutputs } from './smoke-worker.js';

export const GEMINI_SECRET = 'dsa-judge/gemini-api-key';

const repoFile = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const CDK_JSON = repoFile('infra/cdk.json');
const PROMPT_FILE = repoFile('prompts/transcribe.md');
const DRIVERS_FILE = repoFile('worker/DRIVERS.md');

export interface Args {
  imagePath: string;
  questionId: string;
  version?: number;
}

export function parseArgs(argv: readonly string[]): Args {
  // A leading "--" (an extra one typed after the pnpm script name) is dropped.
  const [imagePath, questionId, versionText, ...extra] = argv[0] === '--' ? argv.slice(1) : argv;
  const usage =
    'Usage: AWS_PROFILE=dsa-judge pnpm try:transcribe <imagePath> <questionId> [version]';
  if (!imagePath || !questionId || extra.length > 0) throw new Error(usage);
  if (versionText === undefined) return { imagePath, questionId };
  const version = Number(versionText);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`The version must be a positive whole number, got "${versionText}". ${usage}`);
  }
  return { imagePath, questionId, version };
}

/** The photo's bytes. It must be a JPEG of at most 5 MB, like the ones the app uploads. */
export function readJpeg(path: string): Uint8Array {
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error(`${path} is empty.`);
  if (bytes.length > ANSWER_IMAGE_MAX_BYTES) throw new Error(`${path} is over 5 MB.`);
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error(`${path} is not a JPEG file.`);
  }
  return new Uint8Array(bytes);
}

/** `geminiTranscribeModel` from infra/cdk.json. */
export function readModel(configPath: string = CDK_JSON): string {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    context?: { geminiTranscribeModel?: unknown };
  };
  const model = config.context?.geminiTranscribeModel;
  if (typeof model !== 'string' || model.trim() === '' || model.startsWith('<')) {
    throw new Error(`${configPath} has no usable "geminiTranscribeModel" in its context.`);
  }
  return model.trim();
}

/** One version of a question: the one asked for, or the latest. */
export async function loadQuestion(
  client: DynamoDBDocumentClient,
  table: string,
  questionId: string,
  version?: number,
): Promise<QuestionItem> {
  const item =
    version === undefined
      ? (
          await client.send(
            new QueryCommand({
              TableName: table,
              KeyConditionExpression: 'questionId = :id',
              ExpressionAttributeValues: { ':id': questionId },
              ScanIndexForward: false,
              Limit: 1,
            }),
          )
        ).Items?.[0]
      : (await client.send(new GetCommand({ TableName: table, Key: { questionId, version } })))
          .Item;
  if (!item) {
    throw new Error(
      `No question ${questionId}${version === undefined ? '' : ` version ${version}`} in ${table}.`,
    );
  }
  return item as QuestionItem;
}

export async function loadApiKey(client: SecretsManagerClient): Promise<string> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: GEMINI_SECRET }));
  const key = out.SecretString?.trim();
  if (!key) throw new Error(`The secret ${GEMINI_SECRET} is empty.`);
  return key;
}

export interface TryResult {
  lines: string[];
  verdict: TranscriptionVerdict;
  /** True when every call was rate limited or Gemini was unavailable. */
  busy: boolean;
}

/** Sends the photo to Gemini the way the Lambda does and describes what the Lambda would do. */
export async function tryTranscribe(input: {
  gemini: GeminiClient;
  model: string;
  question: QuestionItem;
  image: Uint8Array;
  promptMarkdown: string;
  driversGuide: string;
  apiKey?: string;
  /** Called with each line as it happens, so waits can be followed live. */
  log?: (line: string) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<TryResult> {
  const lines: string[] = [];
  const secrets = input.apiKey ? [input.apiKey] : [];
  const emit = (line: string) => {
    lines.push(line);
    input.log?.(line);
  };

  const prompt = buildTranscribePrompt(input.promptMarkdown, input.question, input.driversGuide);
  const { verdict, reply, calls, busy } = await transcribeImage({
    gemini: input.gemini,
    model: input.model,
    prompt,
    image: input.image,
    secrets,
    // Every failed call: HTTP status, Google's error status and message (key scrubbed), and what
    // happens next.
    onAttempt: (info) => emit(formatAttempt(info, secrets)),
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.random ? { random: input.random } : {}),
  });

  emit(`Model ${input.model}; ${calls} call${calls === 1 ? '' : 's'} to Gemini.`);
  if (reply !== undefined) {
    let shown = reply;
    try {
      shown = JSON.stringify(JSON.parse(reply), null, 2);
    } catch {
      // not JSON: show it as it came
    }
    emit('Gemini replied:');
    emit(shown);
  }
  if (busy) {
    emit(
      'VALIDATION: not reached. Gemini was rate limited or unavailable on every call. The Lambda would put the page back on the queue and try again later, and only after 3 such tries mark it FAILED_TO_GRADE "Transcription service busy, re-run".',
    );
  } else {
    emit(
      verdict.ok
        ? 'VALIDATION: OK. The Lambda would store this and send it to the worker.'
        : `VALIDATION: FAILED. The Lambda would mark the answer FAILED_TO_GRADE (${verdict.failReason}): ${verdict.detail}`,
    );
  }
  return { lines, verdict, busy };
}

async function main(argv: string[]): Promise<void> {
  const profile = process.env['AWS_PROFILE'];
  if (!profile) {
    throw new Error('Set AWS_PROFILE, e.g. AWS_PROFILE=dsa-judge pnpm try:transcribe photo.jpg q1');
  }
  const args = parseArgs(argv);
  const image = readJpeg(args.imagePath);
  const model = readModel();

  const outputs = await stackOutputs(new CloudFormationClient({ region: REGION }), DATA_STACK);
  const table = outputs['QuestionsTableName'];
  if (!table) throw new Error(`Stack ${DATA_STACK} has no output QuestionsTableName.`);
  const question = await loadQuestion(
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
    table,
    args.questionId,
    args.version,
  );
  const apiKey = await loadApiKey(new SecretsManagerClient({ region: REGION }));

  console.log(
    `Profile ${profile}. Question ${question.questionId} v${question.version} "${question.title}". Calling the real Gemini API...`,
  );
  const { verdict } = await tryTranscribe({
    gemini: createGeminiClient(apiKey),
    model,
    question,
    image,
    promptMarkdown: loadPromptFile(PROMPT_FILE),
    driversGuide: readFileSync(DRIVERS_FILE, 'utf8'),
    apiKey,
    log: (line) => console.log(line),
  });
  if (!verdict.ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
