import {
  LANGUAGES,
  driverContainsCode,
  type FailReason,
  type Language,
  type QuestionItem,
} from '@yulove/shared';
import { z } from 'zod';
import type { GeminiClient } from './gemini.js';
import { extractSection, renderPrompt } from './prompt.js';
import { retryDelayOf } from './google-error.js';
import { withRetries, type AttemptInfo } from './retry.js';

/** One call may take this long. */
export const GEMINI_CALL_TIMEOUT_MS = 40_000;
/** Time kept in hand for saving results and queueing after the last Gemini call. */
export const SAFETY_MARGIN_MS = 10_000;
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 2_000;
export const BUSY_MESSAGE = 'Transcription service busy, re-run';

/** What Gemini is asked to return. */
export const TRANSCRIBE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean' },
    language: { type: 'string', enum: [...LANGUAGES, 'other'] },
    rawTranscription: { type: 'string' },
    correctedCode: { type: 'string' },
    fixes: { type: 'array', items: { type: 'string' } },
    estimatedComplexity: { type: 'string' },
    meetsComplexity: { type: 'boolean' },
    driverCode: { type: 'string' },
  },
  required: [
    'readable',
    'language',
    'rawTranscription',
    'correctedCode',
    'fixes',
    'estimatedComplexity',
    'meetsComplexity',
    'driverCode',
  ],
} as const;

const responseSchema = z.object({
  readable: z.boolean(),
  language: z.string(),
  rawTranscription: z.string(),
  correctedCode: z.string(),
  fixes: z.array(z.string()),
  estimatedComplexity: z.string(),
  meetsComplexity: z.boolean(),
  driverCode: z.string(),
});

export interface Transcription {
  language: Language;
  rawTranscription: string;
  correctedCode: string;
  driverCode: string;
  fixes: string[];
  estimatedComplexity: string;
  meetsComplexity: boolean;
}

export type TranscriptionVerdict =
  | { ok: true; transcription: Transcription }
  | { ok: false; failReason: FailReason; detail: string };

const fail = (failReason: FailReason, detail: string): TranscriptionVerdict => ({
  ok: false,
  failReason,
  detail,
});

/** Gemini's name for a language to ours; undefined for anything we cannot run. */
export function normaliseLanguage(value: string): Language | undefined {
  const name = value.trim().toLowerCase();
  const aliases: Record<string, Language> = {
    python: 'python',
    python3: 'python',
    py: 'python',
    cpp: 'cpp',
    'c++': 'cpp',
    cxx: 'cpp',
    java: 'java',
    go: 'go',
    golang: 'go',
  };
  return aliases[name];
}

/**
 * Checks Gemini's reply before anything goes to the worker, in this order: well-formed JSON of the
 * right shape; the page is readable; the language is Python, C++, Java or Go; there is code; and
 * the driver contains that code unchanged.
 */
export function checkTranscription(text: string): TranscriptionVerdict {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('GEMINI_ERROR', 'Gemini returned malformed JSON');
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      'GEMINI_ERROR',
      `Gemini's reply has missing or wrong fields: ${parsed.error.issues
        .map((i) => i.path.join('.') || 'reply')
        .join(', ')}`,
    );
  }
  const r = parsed.data;

  if (!r.readable) return fail('UNREADABLE', 'The page could not be read');
  const language = normaliseLanguage(r.language);
  if (!language) {
    return fail(
      'UNSUPPORTED_LANGUAGE',
      `The answer is not in Python, C++, Java or Go (Gemini said "${r.language.slice(0, 40)}")`,
    );
  }
  if (r.correctedCode.trim() === '') return fail('UNREADABLE', 'No code found on the page');
  if (!driverContainsCode(r.driverCode, r.correctedCode)) {
    return fail('DRIVER_MISMATCH', 'The driver program changed the student code');
  }
  return {
    ok: true,
    transcription: {
      language,
      rawTranscription: r.rawTranscription,
      correctedCode: r.correctedCode,
      driverCode: r.driverCode,
      fixes: r.fixes,
      estimatedComplexity: r.estimatedComplexity,
      meetsComplexity: r.meetsComplexity,
    },
  };
}

export function signatureText(q: Pick<QuestionItem, 'signature'>): string {
  const s = q.signature;
  if (!s) return '(none)';
  const params = s.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
  return `${s.name}(${params}) -> ${s.returnType}`;
}

/** The prompt for one answer: the question as data, the signature and the drivers guide. */
export function buildTranscribePrompt(
  markdown: string,
  question: QuestionItem,
  driversGuide: string,
): string {
  return renderPrompt(extractSection(markdown, 'transcribe'), {
    title: question.title,
    statement: question.statement,
    ioDescription: question.ioDescription,
    constraints: question.constraints,
    signature: signatureText(question),
    parameterNames: question.signature?.parameters.map((p) => p.name).join(', ') ?? '',
    targetComplexity: question.targetComplexity,
    driversGuide,
  });
}

/** Makes an error message safe to store: no API key, one line, at most 300 characters. */
export function describeError(
  error: unknown,
  secrets: readonly string[] = [],
  prefix = 'Gemini request failed: ',
): string {
  let text = `${prefix}${String(error instanceof Error ? error.message : error)}`;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** One line about a failed call: HTTP status, Google's error status and message, key scrubbed. */
export function describeApiAttempt(error: unknown, secrets: readonly string[] = []): string {
  const e = error as {
    status?: unknown;
    googleStatus?: unknown;
    googleMessage?: unknown;
    message?: unknown;
    name?: unknown;
  } | null;
  let text: string;
  if (typeof e?.status === 'number') {
    const google = typeof e.googleStatus === 'string' ? ` ${e.googleStatus}` : '';
    const message = typeof e.googleMessage === 'string' ? e.googleMessage : String(e.message ?? '');
    text = `HTTP ${e.status}${google}: ${message}`;
  } else {
    text = `${typeof e?.name === 'string' ? e.name : 'Error'}: ${String(e?.message ?? error)}`;
  }
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** A line for each failed call, saying what Gemini answered and what happens next. */
export function formatAttempt(info: AttemptInfo, secrets: readonly string[] = []): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
  const head = `Attempt ${info.call}: ${describeApiAttempt(info.error, secrets)}`;
  if (info.stopped === 'fatal') return `${head} (cannot be retried)`;
  if (info.stopped === 'tries') return `${head} (no tries left)`;
  if (info.stopped === 'time') {
    return `${head}${info.googleDelayMs !== undefined ? ` (Google asks for ${seconds(info.googleDelayMs)})` : ''} (not enough time left to wait, giving up)`;
  }
  return info.usedGoogleDelay
    ? `${head} (Google asks for ${seconds(info.googleDelayMs ?? 0)}; waiting ${seconds(info.nextWaitMs ?? 0)})`
    : `${head} (${info.googleDelayMs !== undefined ? `Google asks for ${seconds(info.googleDelayMs)}, which does not fit; ` : 'no delay given; '}backing off ${seconds(info.nextWaitMs ?? 0)})`;
}

export interface TranscribeInput {
  gemini: GeminiClient;
  model: string;
  prompt: string;
  image: Uint8Array;
  secrets?: readonly string[];
  /** Milliseconds left in the Lambda; infinite when there is no limit (a script). */
  remainingMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called after every failed call to Gemini. */
  onAttempt?: (info: AttemptInfo) => void;
}

export interface TranscribeResult {
  verdict: TranscriptionVerdict;
  /** Gemini's reply text, when it gave one. */
  reply?: string;
  calls: number;
  /**
   * True when every try ended in a 429, a 5xx or a timeout, or there was no time to try again:
   * Gemini is busy, not the answer's fault. `verdict` then says "Transcription service busy,
   * re-run", for callers that give up at once; the Lambda retries later instead.
   */
  busy: boolean;
  /** The wait Google last asked for, in milliseconds. */
  retryDelayMs?: number;
}

/**
 * Sends the photo and prompt to Gemini and checks what comes back. 429 and 5xx errors (and
 * dropped connections) are retried up to 3 times with backoff while there is time; if they never
 * clear, the answer fails as "Transcription service busy, re-run".
 */
export async function transcribeImage(input: TranscribeInput): Promise<TranscribeResult> {
  const result = await withRetries(
    () =>
      input.gemini.generateJson({
        model: input.model,
        prompt: input.prompt,
        schema: TRANSCRIBE_RESPONSE_SCHEMA,
        image: { mimeType: 'image/jpeg', data: input.image },
        timeoutMs: GEMINI_CALL_TIMEOUT_MS,
      }),
    {
      retries: MAX_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      remainingMs: input.remainingMs ?? (() => Number.POSITIVE_INFINITY),
      attemptBudgetMs: GEMINI_CALL_TIMEOUT_MS + SAFETY_MARGIN_MS,
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.random ? { random: input.random } : {}),
      ...(input.onAttempt ? { onAttempt: input.onAttempt } : {}),
    },
  );

  if (result.value === undefined) {
    const delay = result.googleDelayMs ?? (result.busy ? retryDelayOf(result.error) : undefined);
    return {
      calls: result.calls,
      busy: result.busy,
      ...(delay !== undefined ? { retryDelayMs: delay } : {}),
      verdict: result.fatal
        ? fail('GEMINI_ERROR', describeError(result.error, input.secrets))
        : fail('GEMINI_ERROR', BUSY_MESSAGE),
    };
  }
  return {
    calls: result.calls,
    busy: false,
    reply: result.value,
    verdict: checkTranscription(result.value),
  };
}
