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

const { createGeminiClient } = await import('./gemini.js');

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
});
