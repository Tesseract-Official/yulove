import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  GeminiApiError,
  type GeminiClient,
  type GenerateJsonRequest,
} from '@yulove/pipeline/transcribe';
import type { QuestionItem } from '@yulove/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GEMINI_SECRET,
  loadApiKey,
  loadQuestion,
  parseArgs,
  readJpeg,
  readModel,
  tryTranscribe,
} from './try-transcribe.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const smMock = mockClient(SecretsManagerClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));

const CODE = 'def solve(nums):\n    return sum(nums)';
const DRIVER = `import json\nimport sys\n\n${CODE}\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`;
const reply = (change: Record<string, unknown> = {}) =>
  JSON.stringify({
    readable: true,
    language: 'python',
    rawTranscription: 'raw',
    correctedCode: CODE,
    fixes: ['added a colon'],
    estimatedComplexity: 'O(n)',
    meetsComplexity: true,
    driverCode: DRIVER,
    ...change,
  });

const question: QuestionItem = {
  questionId: 'q1',
  version: 2,
  teacherEmail: 't@college.edu',
  title: 'Sum',
  statement: 'Return the sum.',
  ioDescription: 'nums in, sum out',
  constraints: 'n <= 1000',
  examples: [],
  signature: { name: 'solve', parameters: [{ name: 'nums', type: 'int[]' }], returnType: 'int' },
  targetComplexity: 'O(n)',
  timeLimitMs: 1000,
  memoryMb: 128,
  compareMode: 'EXACT',
};

class FakeGemini implements GeminiClient {
  readonly requests: GenerateJsonRequest[] = [];
  constructor(private readonly text: string) {}
  async generateJson(request: GenerateJsonRequest) {
    this.requests.push(request);
    return this.text;
  }
}

const promptMarkdown = readFileSync(
  fileURLToPath(new URL('../prompts/transcribe.md', import.meta.url)),
  'utf8',
);
const driversGuide = readFileSync(
  fileURLToPath(new URL('../worker/DRIVERS.md', import.meta.url)),
  'utf8',
);

const tmp = () => mkdtempSync(join(tmpdir(), 'try-'));
const input = (gemini: GeminiClient, extra: { apiKey?: string } = {}) => ({
  gemini,
  model: 'gemini-test',
  question,
  image: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
  promptMarkdown,
  driversGuide,
  ...extra,
});

beforeEach(() => {
  ddbMock.reset();
  smMock.reset();
});

describe('parseArgs', () => {
  it('takes an image, a question id and an optional version', () => {
    expect(parseArgs(['photo.jpg', 'q1'])).toEqual({ imagePath: 'photo.jpg', questionId: 'q1' });
    expect(parseArgs(['photo.jpg', 'q1', '3'])).toEqual({
      imagePath: 'photo.jpg',
      questionId: 'q1',
      version: 3,
    });
  });

  it.each([
    [[]],
    [['photo.jpg']],
    [['a', 'b', 'x']],
    [['a', 'b', '0']],
    [['a', 'b', '1', 'extra']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/Usage|version/);
  });
});

describe('readJpeg', () => {
  it('reads a JPEG', () => {
    const file = join(tmp(), 'a.jpg');
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    expect([...readJpeg(file)]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  });

  it('refuses something that is not a JPEG, is empty or is too big', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'empty'), Buffer.alloc(0));
    writeFileSync(
      join(dir, 'big'),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]),
    );
    expect(() => readJpeg(join(dir, 'png'))).toThrow(/not a JPEG/);
    expect(() => readJpeg(join(dir, 'empty'))).toThrow(/empty/);
    expect(() => readJpeg(join(dir, 'big'))).toThrow(/over 5 MB/);
  });
});

describe('readModel', () => {
  it("reads geminiTranscribeModel from the repository's infra/cdk.json", () => {
    expect(readModel()).toMatch(/^gemini-/);
  });

  it('refuses a missing or placeholder model', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ context: {} }));
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify({ context: { geminiTranscribeModel: '<MODEL>' } }),
    );
    expect(() => readModel(join(dir, 'a.json'))).toThrow(/geminiTranscribeModel/);
    expect(() => readModel(join(dir, 'b.json'))).toThrow(/geminiTranscribeModel/);
  });
});

describe('loadQuestion', () => {
  it('reads the version asked for', async () => {
    ddbMock.on(GetCommand).resolves({ Item: question });
    await expect(loadQuestion(ddb, 'Questions', 'q1', 2)).resolves.toEqual(question);
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toEqual({
      TableName: 'Questions',
      Key: { questionId: 'q1', version: 2 },
    });
  });

  it('reads the latest version when none is given', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [question] });
    await loadQuestion(ddb, 'Questions', 'q1');
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      ScanIndexForward: false,
      Limit: 1,
    });
  });

  it('says so when there is no such question', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(loadQuestion(ddb, 'Questions', 'nope')).rejects.toThrow(/No question nope/);
  });
});

describe('loadApiKey', () => {
  it('reads the deployed secret', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: ' key-1\n' });
    await expect(loadApiKey(new SecretsManagerClient({ region: 'ap-south-1' }))).resolves.toBe(
      'key-1',
    );
    expect(smMock.commandCalls(GetSecretValueCommand)[0]?.args[0].input).toEqual({
      SecretId: GEMINI_SECRET,
    });
    expect(GEMINI_SECRET).toBe('dsa-judge/gemini-api-key');
  });

  it('refuses an empty secret', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: ' ' });
    await expect(loadApiKey(new SecretsManagerClient({}))).rejects.toThrow(/empty/);
  });
});

describe('tryTranscribe', () => {
  it('prints the JSON and says the answer would go to the worker', async () => {
    const gemini = new FakeGemini(reply());
    const { lines, verdict } = await tryTranscribe(input(gemini));

    expect(verdict.ok).toBe(true);
    expect(lines.join('\n')).toContain('"correctedCode"');
    expect(lines.at(-1)).toMatch(/VALIDATION: OK/);
    expect(gemini.requests[0]).toMatchObject({
      model: 'gemini-test',
      image: { mimeType: 'image/jpeg' },
    });
    expect(gemini.requests[0]?.prompt).toContain('Return the sum.');
    expect(gemini.requests[0]?.prompt).toContain(driversGuide);
  });

  it.each([
    ['an unreadable page', { readable: false, correctedCode: '' }, 'UNREADABLE'],
    ['an unsupported language', { language: 'other' }, 'UNSUPPORTED_LANGUAGE'],
    [
      'a driver that alters the code',
      { driverCode: DRIVER.replace('sum', 'max') },
      'DRIVER_MISMATCH',
    ],
  ])('shows the failure for %s', async (_name, change, failReason) => {
    const { lines, verdict } = await tryTranscribe(input(new FakeGemini(reply(change))));

    expect(verdict).toMatchObject({ ok: false, failReason });
    expect(lines.at(-1)).toMatch(new RegExp(`VALIDATION: FAILED.*${failReason}`));
  });

  it('shows a reply that is not JSON as it came, and fails', async () => {
    const { lines, verdict } = await tryTranscribe(input(new FakeGemini('not json')));
    expect(lines).toContain('not json');
    expect(verdict).toMatchObject({ ok: false, failReason: 'GEMINI_ERROR' });
  });

  it('does not print the API key', async () => {
    const gemini: GeminiClient = {
      async generateJson() {
        throw new Error('invalid key AIza-secret-key');
      },
    };
    const { lines } = await tryTranscribe(input(gemini, { apiKey: 'AIza-secret-key' }));
    expect(lines.join('\n')).not.toContain('AIza-secret-key');
  });
});

describe('tryTranscribe: why Gemini calls fail', () => {
  const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';
  const limited = (retryDelay?: string, message = 'Quota exceeded for metric X') =>
    new GeminiApiError(
      429,
      JSON.stringify({
        error: {
          code: 429,
          message,
          status: 'RESOURCE_EXHAUSTED',
          ...(retryDelay ? { details: [{ '@type': RETRY_INFO, retryDelay }] } : {}),
        },
      }),
    );

  class Scripted implements GeminiClient {
    calls = 0;
    constructor(private readonly replies: Array<string | Error>) {}
    async generateJson() {
      this.calls += 1;
      const next = this.replies.shift();
      if (next === undefined) throw new Error('no reply left');
      if (next instanceof Error) throw next;
      return next;
    }
  }

  const waits: number[] = [];
  const run = (gemini: GeminiClient, extra: { apiKey?: string } = {}) => {
    const live: string[] = [];
    return tryTranscribe({
      ...input(gemini, extra),
      log: (line) => live.push(line),
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
    }).then((result) => ({ ...result, live }));
  };

  beforeEach(() => {
    waits.length = 0;
  });

  it("prints each failed call's HTTP status and Google's error status and message", async () => {
    const { lines } = await run(new Scripted([limited('3s'), limited(), reply()]));

    expect(lines.slice(0, 2)).toEqual([
      'Attempt 1: HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for metric X (Google asks for 3 s; waiting 3.3 s)',
      'Attempt 2: HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for metric X (no delay given; backing off 4 s)',
    ]);
    expect(waits).toEqual([3250, 4000]);
    expect(lines.at(-1)).toMatch(/VALIDATION: OK/);
  });

  it('shows 5xx errors, with the status Google gave', async () => {
    const down = new GeminiApiError(
      503,
      JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'The model is overloaded' } }),
    );
    const { lines } = await run(new Scripted([down, reply()]));
    expect(lines[0]).toMatch(
      /^Attempt 1: HTTP 503 UNAVAILABLE: The model is overloaded \(no delay given; backing off 2 s\)$/,
    );
  });

  it('shows an error that cannot be retried and why the run ends', async () => {
    const bad = new GeminiApiError(
      400,
      JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }),
    );
    const { lines, verdict, busy } = await run(new Scripted([bad]));

    expect(lines[0]).toBe(
      'Attempt 1: HTTP 400 INVALID_ARGUMENT: API key not valid (cannot be retried)',
    );
    expect(busy).toBe(false);
    expect(verdict).toMatchObject({ ok: false, failReason: 'GEMINI_ERROR' });
    expect(lines.at(-1)).toMatch(/VALIDATION: FAILED/);
  });

  it('when every call is rate limited, says it is busy and what the Lambda would do', async () => {
    const { lines, busy, verdict } = await run(new Scripted([1, 2, 3, 4].map(() => limited('2s'))));

    expect(busy).toBe(true);
    expect(lines.filter((l) => l.startsWith('Attempt '))).toHaveLength(4);
    expect(lines.find((l) => l.startsWith('Attempt 4'))).toMatch(/\(no tries left\)$/);
    expect(lines.at(-1)).toMatch(
      /VALIDATION: not reached.*3 such tries.*Transcription service busy, re-run/,
    );
    expect(verdict).toMatchObject({ ok: false });
  });

  it('prints lines as they happen, not only at the end', async () => {
    const { live, lines } = await run(new Scripted([limited(), reply()]));
    expect(live).toEqual(lines);
  });

  it('scrubs the API key from every line', async () => {
    const leaky = limited(undefined, 'Invalid key AIza-secret-key supplied');
    const { lines } = await run(
      new Scripted([leaky, new Error('again AIza-secret-key'), reply()]),
      {
        apiKey: 'AIza-secret-key',
      },
    );

    expect(lines.join('\n')).not.toContain('AIza-secret-key');
    expect(lines.join('\n')).toContain('[redacted]');
  });
});

describe('running the script', () => {
  it('refuses to start without AWS_PROFILE, before touching AWS or Gemini', () => {
    const env = { ...process.env };
    delete env['AWS_PROFILE'];
    const result = spawnSync('pnpm', ['exec', 'tsx', 'try-transcribe.ts', 'a.jpg', 'q1'], {
      cwd: new URL('.', import.meta.url),
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Set AWS_PROFILE/);
  });
});

describe('parseArgs and the extra --', () => {
  it('ignores a leading -- that pnpm passes on', async () => {
    const { parseArgs } = await import('./try-transcribe.js');
    expect(parseArgs(['--', 'photo.jpg', 'q1', '2'])).toEqual({
      imagePath: 'photo.jpg',
      questionId: 'q1',
      version: 2,
    });
  });
});
