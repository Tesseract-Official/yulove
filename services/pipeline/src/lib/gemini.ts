import { GoogleGenAI } from '@google/genai';
import { googleErrorInfo } from './google-error.js';

export interface GenerateJsonRequest {
  model: string;
  prompt: string;
  /** JSON Schema for the response. */
  schema: object;
  /** A picture sent along with the prompt, for example a photographed answer page. */
  image?: { mimeType: string; data: Uint8Array };
  /** Gives up on one call after this long. */
  timeoutMs?: number;
}

/**
 * A failed Gemini API call, with what Google said about it. `status` is the HTTP status, so the
 * retry logic treats it like the SDK's own error; the original error is kept as `cause`.
 */
export class GeminiApiError extends Error {
  readonly status: number;
  readonly googleStatus: string | undefined;
  readonly googleMessage: string | undefined;
  /** The wait Google asked for (RetryInfo), in milliseconds. */
  readonly retryDelayMs: number | undefined;

  constructor(status: number, rawMessage: string, cause?: unknown) {
    const info = googleErrorInfo(rawMessage);
    const detail = info.googleMessage ?? rawMessage;
    super(`HTTP ${status}${info.googleStatus ? ` ${info.googleStatus}` : ''}: ${detail}`, {
      cause,
    });
    this.name = 'GeminiApiError';
    this.status = status;
    this.googleStatus = info.googleStatus;
    this.googleMessage = info.googleMessage;
    this.retryDelayMs = info.retryDelayMs;
  }
}

/** Turns the SDK's HTTP error into a GeminiApiError; any other error is returned as it is. */
export function wrapGeminiError(error: unknown): unknown {
  if (error instanceof GeminiApiError) return error;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && error instanceof Error) {
    return new GeminiApiError(status, error.message, error);
  }
  return error;
}

/** The only part of Gemini the pipeline uses. Tests supply a fake. */
export interface GeminiClient {
  /** Returns the model's JSON response as text. */
  generateJson(request: GenerateJsonRequest): Promise<string>;
}

/** Temperature 0 and a JSON response schema, as docs/DESIGN.md requires. */
export function createGeminiClient(apiKey: string): GeminiClient {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generateJson({ model, prompt, schema, image, timeoutMs }) {
      let response;
      try {
        response = await ai.models.generateContent({
          model,
          contents: image
            ? [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: image.mimeType,
                        data: Buffer.from(image.data).toString('base64'),
                      },
                    },
                  ],
                },
              ]
            : prompt,
          config: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            ...(timeoutMs ? { httpOptions: { timeout: timeoutMs } } : {}),
          },
        });
      } catch (error) {
        throw wrapGeminiError(error);
      }
      if (!response.text) throw new Error('Gemini returned no text');
      return response.text;
    },
  };
}
