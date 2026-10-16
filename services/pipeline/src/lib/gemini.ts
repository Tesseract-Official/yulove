import { GoogleGenAI } from '@google/genai';

export interface GenerateJsonRequest {
  model: string;
  prompt: string;
  /** JSON Schema for the response. */
  schema: object;
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
    async generateJson({ model, prompt, schema }) {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      });
      if (!response.text) throw new Error('Gemini returned no text');
      return response.text;
    },
  };
}
