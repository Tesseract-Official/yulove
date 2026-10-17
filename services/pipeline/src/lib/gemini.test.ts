import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateContent = vi.fn();
const constructed = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: unknown) {
      constructed(options);
    }
  },
}));

const { createGeminiClient, GeminiApiError, wrapGeminiError } = await import('./gemini.js');

beforeEach(() => {
  generateContent.mockReset();
  constructed.mockReset();
});

describe('createGeminiClient', () => {
  it('asks for JSON at temperature 0 with the given schema and model', async () => {
    generateContent.mockResolvedValue({ text: '{"ok":true}' });
    const schema = { type: 'object' };

    const text = await createGeminiClient('key-1').generateJson({
      model: 'gemini-x',
      prompt: 'hello',
      schema,
    });

    expect(text).toBe('{"ok":true}');
    expect(constructed).toHaveBeenCalledWith({ apiKey: 'key-1' });
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-x',
      contents: 'hello',
      config: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: schema },
    });
  });

  it('fails when Gemini returns no text', async () => {
    generateContent.mockResolvedValue({ text: undefined });

    await expect(
      createGeminiClient('k').generateJson({ model: 'm', prompt: 'p', schema: {} }),
    ).rejects.toThrow(/no text/);
  });

  it('sends a photo as inline data beside the prompt, with a timeout', async () => {
    generateContent.mockResolvedValue({ text: '{}' });

    await createGeminiClient('k').generateJson({
      model: 'm',
      prompt: 'read this',
      schema: { type: 'object' },
      image: { mimeType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) },
      timeoutMs: 40_000,
    });

    expect(generateContent).toHaveBeenCalledWith({
      model: 'm',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'read this' }, { inlineData: { mimeType: 'image/jpeg', data: 'AQID' } }],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        httpOptions: { timeout: 40_000 },
      },
    });
  });
});

const sdkError = (status: number, error: object) =>
  Object.assign(new Error(JSON.stringify({ error })), { name: 'ApiError', status });

describe('failures from the SDK', () => {
  it("become a GeminiApiError with Google's status, message and requested delay", async () => {
    generateContent.mockRejectedValue(
      sdkError(429, {
        code: 429,
        message: 'Quota exceeded',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }],
      }),
    );

    const error = await createGeminiClient('k')
      .generateJson({ model: 'm', prompt: 'p', schema: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeminiApiError);
    expect(error).toMatchObject({
      status: 429,
      googleStatus: 'RESOURCE_EXHAUSTED',
      googleMessage: 'Quota exceeded',
      retryDelayMs: 34_000,
      message: 'HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded',
    });
  });

  it('keep the HTTP status when the body is not JSON', () => {
    const error = wrapGeminiError(Object.assign(new Error('upstream timeout'), { status: 504 }));
    expect(error).toBeInstanceOf(GeminiApiError);
    expect(error).toMatchObject({ status: 504, message: 'HTTP 504: upstream timeout' });
  });

  it('leave errors without an HTTP status alone', async () => {
    const dropped = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    generateContent.mockRejectedValue(dropped);
    await expect(
      createGeminiClient('k').generateJson({ model: 'm', prompt: 'p', schema: {} }),
    ).rejects.toBe(dropped);
    expect(wrapGeminiError('text')).toBe('text');
  });

  it('are wrapped only once', () => {
    const once = wrapGeminiError(sdkError(500, { message: 'x' }));
    expect(wrapGeminiError(once)).toBe(once);
  });
});
