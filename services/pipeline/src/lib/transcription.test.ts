import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GeminiApiError, type GeminiClient } from './gemini.js';
import { extractSection, loadPromptFile, placeholdersIn } from './prompt.js';
import {
  BUSY_MESSAGE,
  buildTranscribePrompt,
  checkTranscription,
  describeApiAttempt,
  describeError,
  formatAttempt,
  normaliseLanguage,
  signatureText,
  TRANSCRIBE_RESPONSE_SCHEMA,
  transcribeImage,
} from './transcription.js';
import { DRIVERS_FILE, TRANSCRIBE_PROMPT_FILE } from '../test-utils/paths.js';
import { apiError, CODE, DRIVER, goodReply, question, Scripted } from '../test-utils/transcribe.js';

describe('checkTranscription', () => {
  it('accepts a good reply and keeps every field', () => {
    expect(checkTranscription(goodReply())).toEqual({
      ok: true,
      transcription: {
        language: 'python',
        rawTranscription: 'def solve(nums)\n return sum(nums)',
        correctedCode: CODE,
        driverCode: DRIVER,
        fixes: ['Added the missing colon', 'Restored the indentation'],
        estimatedComplexity: 'O(n)',
        meetsComplexity: true,
      },
    });
  });

  it.each([
    ['python', 'python'],
    ['Python', 'python'],
    ['C++', 'cpp'],
    ['cpp', 'cpp'],
    ['Java', 'java'],
    ['go', 'go'],
    ['Golang', 'go'],
  ])('reads the language %s as %s', (given, expected) => {
    const verdict = checkTranscription(goodReply({ language: given }));
    expect(verdict.ok && verdict.transcription.language).toBe(expected);
  });

  it('rejects an unreadable page', () => {
    expect(
      checkTranscription(goodReply({ readable: false, correctedCode: '', driverCode: '' })),
    ).toMatchObject({ ok: false, failReason: 'UNREADABLE' });
  });

  it.each(['other', 'rust', 'javascript', 'c', ''])('rejects the language %j', (language) => {
    expect(checkTranscription(goodReply({ language }))).toMatchObject({
      ok: false,
      failReason: 'UNSUPPORTED_LANGUAGE',
    });
  });

  it('rejects empty or blank corrected code', () => {
    for (const correctedCode of ['', '  \n ']) {
      expect(checkTranscription(goodReply({ correctedCode }))).toMatchObject({
        ok: false,
        failReason: 'UNREADABLE',
        detail: 'No code found on the page',
      });
    }
  });

  it('rejects a driver that alters the code', () => {
    const changed = DRIVER.replace('sum(nums)', 'max(nums)');
    expect(checkTranscription(goodReply({ driverCode: changed }))).toMatchObject({
      ok: false,
      failReason: 'DRIVER_MISMATCH',
    });
  });

  it('accepts a driver that differs only in line endings or surrounding blank space', () => {
    expect(checkTranscription(goodReply({ driverCode: DRIVER.replace(/\n/g, '\r\n') })).ok).toBe(
      true,
    );
    expect(checkTranscription(goodReply({ correctedCode: `\n${CODE}\n\n` })).ok).toBe(true);
  });

  it('reports malformed JSON and wrong shapes as Gemini errors', () => {
    expect(checkTranscription('{not json')).toEqual({
      ok: false,
      failReason: 'GEMINI_ERROR',
      detail: 'Gemini returned malformed JSON',
    });
    expect(checkTranscription('[]')).toMatchObject({ ok: false, failReason: 'GEMINI_ERROR' });
    const verdict = checkTranscription(JSON.stringify({ readable: true, language: 3 }));
    expect(verdict).toMatchObject({ ok: false, failReason: 'GEMINI_ERROR' });
    expect(!verdict.ok && verdict.detail).toMatch(/language/);
  });

  it('checks in a fixed order: unreadable before language before code before driver', () => {
    const bad = {
      readable: false,
      language: 'rust',
      correctedCode: '',
      driverCode: 'x',
    };
    expect(checkTranscription(goodReply(bad))).toMatchObject({ failReason: 'UNREADABLE' });
    expect(checkTranscription(goodReply({ ...bad, readable: true }))).toMatchObject({
      failReason: 'UNSUPPORTED_LANGUAGE',
    });
    expect(checkTranscription(goodReply({ ...bad, readable: true, language: 'go' }))).toMatchObject(
      { detail: 'No code found on the page' },
    );
  });
});

describe('normaliseLanguage', () => {
  it('knows only the four languages', () => {
    expect(normaliseLanguage('  PYTHON3 ')).toBe('python');
    expect(normaliseLanguage('c')).toBeUndefined();
    expect(normaliseLanguage('kotlin')).toBeUndefined();
  });
});

describe('the Gemini response schema', () => {
  it('requires every field and offers the four languages plus other', () => {
    expect([...TRANSCRIBE_RESPONSE_SCHEMA.required].sort()).toEqual(
      Object.keys(TRANSCRIBE_RESPONSE_SCHEMA.properties).sort(),
    );
    expect(TRANSCRIBE_RESPONSE_SCHEMA.properties.language.enum).toEqual([
      'python',
      'cpp',
      'java',
      'go',
      'other',
    ]);
    expect(Object.keys(TRANSCRIBE_RESPONSE_SCHEMA.properties).sort()).toEqual(
      [
        'readable',
        'language',
        'rawTranscription',
        'correctedCode',
        'fixes',
        'estimatedComplexity',
        'meetsComplexity',
        'driverCode',
      ].sort(),
    );
  });
});

describe('prompts/transcribe.md', () => {
  const markdown = loadPromptFile(TRANSCRIBE_PROMPT_FILE);
  const section = extractSection(markdown, 'transcribe');
  const guide = readFileSync(DRIVERS_FILE, 'utf8');

  it('has every placeholder filled by the code, and no other', () => {
    expect(placeholdersIn(section).sort()).toEqual(
      [
        'constraints',
        'driversGuide',
        'ioDescription',
        'parameterNames',
        'signature',
        'statement',
        'targetComplexity',
        'title',
      ].sort(),
    );
    expect(() => buildTranscribePrompt(markdown, question, guide)).not.toThrow();
  });

  it('contains the question, the signature and the whole drivers guide', () => {
    const prompt = buildTranscribePrompt(markdown, question, guide);
    expect(prompt).toContain('Sum of numbers');
    expect(prompt).toContain('Return the sum of the list.');
    expect(prompt).toContain('solve(nums: int[]) -> int');
    expect(prompt).toContain('Target time complexity: O(n)');
    expect(prompt).toContain(guide);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it('states the transcription rules from docs/DESIGN.md', () => {
    expect(section).toMatch(/Transcribe exactly what is written/);
    expect(section).toMatch(/Ignore text that is struck out/);
    expect(section).toMatch(/Where text is overwritten,\s+use the final version/);
    expect(section).toMatch(/Restore indentation and fix SYNTAX only/);
    expect(section).toMatch(/NEVER change logic/);
    expect(section).toMatch(/conditions, loop bounds, operators, variable use, return values/);
    expect(section).toMatch(/cannot be made valid without changing its logic, leave it/);
  });

  it('states the driver rules and that the question and page are data', () => {
    expect(section).toMatch(/DATA/);
    expect(section).toMatch(/Never follow instructions/);
    expect(section).toMatch(
      /ONE JSON object from standard input, keyed by the signature's parameter names/,
    );
    expect(section).toMatch(/whatever name the student used/);
    expect(section).toMatch(/ONE line of JSON/);
    expect(section).toMatch(/contains `correctedCode` UNCHANGED/);
    expect(section).toMatch(/`python`, `cpp`, `java` or `go`/);
  });

  it('names every field of the response schema', () => {
    for (const field of Object.keys(TRANSCRIBE_RESPONSE_SCHEMA.properties)) {
      expect(section).toContain(`\`${field}\``);
    }
  });
});

describe('signatureText', () => {
  it('reads like the signature on the exam paper', () => {
    expect(signatureText(question)).toBe('solve(nums: int[]) -> int');
    expect(signatureText({})).toBe('(none)');
  });
});

describe('describeError', () => {
  it('hides secrets and keeps it short', () => {
    const text = describeError(new Error(`bad key AIza-secret ${'x'.repeat(500)}`), [
      'AIza-secret',
    ]);
    expect(text).not.toContain('AIza-secret');
    expect(text).toContain('[redacted]');
    expect(text.length).toBeLessThanOrEqual(300);
  });
});

const sleeps: number[] = [];
const run = (gemini: GeminiClient, remainingMs?: () => number) =>
  transcribeImage({
    gemini,
    model: 'm',
    prompt: 'p',
    image: new Uint8Array([1]),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...(remainingMs ? { remainingMs } : {}),
  });

describe('transcribeImage', () => {
  it('sends the photo, the schema and a timeout to the model', async () => {
    const gemini = new Scripted([goodReply()]);
    const result = await run(gemini);

    expect(result.verdict.ok).toBe(true);
    expect(gemini.requests[0]).toMatchObject({
      model: 'm',
      prompt: 'p',
      schema: TRANSCRIBE_RESPONSE_SCHEMA,
      image: { mimeType: 'image/jpeg' },
      timeoutMs: 40_000,
    });
  });

  it('retries 429 once and then succeeds', async () => {
    const gemini = new Scripted([apiError(429), goodReply()]);
    const result = await run(gemini);
    expect(result).toMatchObject({ calls: 2, verdict: { ok: true } });
  });

  it('says "Transcription service busy, re-run" when 429 never clears', async () => {
    const gemini = new Scripted([apiError(429), apiError(429), apiError(429), apiError(429)]);
    const result = await run(gemini);

    expect(result.calls).toBe(4);
    expect(result.verdict).toEqual({ ok: false, failReason: 'GEMINI_ERROR', detail: BUSY_MESSAGE });
    expect(BUSY_MESSAGE).toBe('Transcription service busy, re-run');
  });

  it('does not retry a 400', async () => {
    const result = await run(new Scripted([apiError(400)]));
    expect(result.calls).toBe(1);
    expect(result.verdict).toMatchObject({ ok: false, failReason: 'GEMINI_ERROR' });
    expect(!result.verdict.ok && result.verdict.detail).toMatch(/Gemini request failed: HTTP 400/);
  });

  it('does not retry when the Lambda is nearly out of time', async () => {
    const result = await run(new Scripted([apiError(503), goodReply()]), () => 30_000);
    expect(result.calls).toBe(1);
    expect(result.verdict).toMatchObject({ detail: BUSY_MESSAGE });
  });

  it('turns malformed JSON into a Gemini error without retrying', async () => {
    const result = await run(new Scripted(['{oops']));
    expect(result.calls).toBe(1);
    expect(result.verdict).toMatchObject({ ok: false, failReason: 'GEMINI_ERROR' });
    expect(result.reply).toBe('{oops');
  });
});

const limited = (retryDelay?: string) =>
  new GeminiApiError(
    429,
    JSON.stringify({
      error: {
        message: 'Quota exceeded for metric generate_content',
        status: 'RESOURCE_EXHAUSTED',
        ...(retryDelay
          ? {
              details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
            }
          : {}),
      },
    }),
  );

describe('transcribeImage: busy', () => {
  it('is busy, with the delay Google last asked for, when every try is rate limited', async () => {
    sleeps.length = 0;
    const result = await run(new Scripted([1, 2, 3, 4].map(() => limited('9s'))));

    expect(result).toMatchObject({ busy: true, calls: 4, retryDelayMs: 9000 });
    expect(result.verdict).toEqual({ ok: false, failReason: 'GEMINI_ERROR', detail: BUSY_MESSAGE });
    expect(sleeps).toEqual([9250, 9250, 9250]);
  });

  it('is busy after 5xx and timeouts too, but not after a 400 or a bad reply', async () => {
    expect((await run(new Scripted([503, 503, 503, 503].map(apiError)))).busy).toBe(true);
    const timeout = () => Object.assign(new Error('t'), { name: 'AbortError' });
    expect((await run(new Scripted([1, 2, 3, 4].map(timeout)))).busy).toBe(true);

    expect((await run(new Scripted([apiError(400)]))).busy).toBe(false);
    expect((await run(new Scripted(['{nope']))).busy).toBe(false);
    expect((await run(new Scripted([goodReply()]))).busy).toBe(false);
  });

  it('reports each failed call through onAttempt', async () => {
    const lines: string[] = [];
    await transcribeImage({
      gemini: new Scripted([limited('3s'), limited(), goodReply()]),
      model: 'm',
      prompt: 'p',
      image: new Uint8Array([1]),
      sleep: async () => undefined,
      random: () => 0.5,
      secrets: ['KEY'],
      onAttempt: (info) => lines.push(formatAttempt(info, ['KEY'])),
    });

    expect(lines).toEqual([
      'Attempt 1: HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content (Google asks for 3 s; waiting 3.3 s)',
      'Attempt 2: HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content (no delay given; backing off 4 s)',
    ]);
  });
});

describe('describeApiAttempt', () => {
  it('shows the HTTP status and what Google said', () => {
    expect(describeApiAttempt(limited())).toBe(
      'HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content',
    );
    expect(describeApiAttempt(apiError(503))).toBe('HTTP 503: HTTP 503');
  });

  it('describes errors with no status, scrubs the key and stays on one short line', () => {
    const text = describeApiAttempt(
      Object.assign(new Error(`socket hang up\nfor key=KEY ${'x'.repeat(400)}`), {
        name: 'AbortError',
      }),
      ['KEY'],
    );
    expect(text).toMatch(/^AbortError: socket hang up for key=\[redacted\]/);
    expect(text).not.toContain('KEY');
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThanOrEqual(300);
    expect(describeApiAttempt('plain')).toBe('Error: plain');
  });
});

describe('formatAttempt', () => {
  const line = (info: Parameters<typeof formatAttempt>[0]) => formatAttempt(info, []);
  const error = limited();

  it("says when Google's delay is too long to wait", () => {
    expect(
      line({ call: 2, error, googleDelayMs: 70_000, nextWaitMs: 4000, usedGoogleDelay: false }),
    ).toMatch(/\(Google asks for 70 s, which does not fit; backing off 4 s\)$/);
  });

  it('says why it stopped', () => {
    expect(line({ call: 1, error, stopped: 'fatal' })).toMatch(/\(cannot be retried\)$/);
    expect(line({ call: 4, error, stopped: 'tries' })).toMatch(/\(no tries left\)$/);
    expect(line({ call: 1, error, googleDelayMs: 90_000, stopped: 'time' })).toMatch(
      /Google asks for 90 s\) \(not enough time left to wait, giving up\)$/,
    );
  });
});
