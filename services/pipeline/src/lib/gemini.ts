import { GoogleGenAI } from '@google/genai';

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
      const response = await ai.models.generateContent({
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
      if (!response.text) throw new Error('Gemini returned no text');
      return response.text;
    },
  };
}
