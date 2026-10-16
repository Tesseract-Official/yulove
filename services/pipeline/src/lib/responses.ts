import { TEST_COUNTS, type Signature } from '@yulove/shared';
import { z } from 'zod';

/** A problem with what Gemini returned. The message is shown to the teacher. */
export class GenerationError extends Error {}

const nonEmpty = z.string().trim().min(1);

const signatureSchema = z.object({
  name: nonEmpty,
  parameters: z.array(z.object({ name: nonEmpty, type: nonEmpty })),
  returnType: nonEmpty,
});

const generatedSchema = z.object({
  signature: signatureSchema,
  referenceSolution: nonEmpty,
  smallInputs: z.array(z.string()),
  generatorScript: nonEmpty,
});

const regeneratedSchema = z.object({
  replacements: z.array(z.object({ index: z.number().int(), input: z.string() })),
  generatorScript: z.string().optional(),
});

/** JSON Schema sent to Gemini for the first generation. */
export const GENERATE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    signature: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parameters: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string' } },
            required: ['name', 'type'],
          },
        },
        returnType: { type: 'string' },
      },
      required: ['name', 'parameters', 'returnType'],
    },
    referenceSolution: { type: 'string' },
    smallInputs: {
      type: 'array',
      items: { type: 'string' },
      minItems: TEST_COUNTS.small,
      maxItems: TEST_COUNTS.small,
    },
    generatorScript: { type: 'string' },
  },
  required: ['signature', 'referenceSolution', 'smallInputs', 'generatorScript'],
} as const;

/** JSON Schema sent to Gemini when it replaces failed inputs. */
export const REGENERATE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    replacements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, input: { type: 'string' } },
        required: ['index', 'input'],
      },
    },
    generatorScript: { type: 'string' },
  },
  required: ['replacements'],
} as const;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GenerationError('Gemini returned malformed JSON');
  }
}

/**
 * Checks one test input: JSON object text whose keys are exactly the parameter names.
 * Returns it in compact form.
 */
export function normaliseInput(text: string, signature: Signature, label: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GenerationError(`${label} is not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GenerationError(`${label} must be a JSON object keyed by parameter name`);
  }
  const keys = Object.keys(value).sort();
  const expected = signature.parameters.map((p) => p.name).sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new GenerationError(
      `${label} has keys [${keys.join(', ')}] but the signature has [${expected.join(', ')}]`,
    );
  }
  return JSON.stringify(value);
}

export interface GeneratedTests {
  signature: Signature;
  referenceSolution: string;
  /** Exactly 7, compact JSON, all different. */
  smallInputs: string[];
  generatorScript: string;
}

/** Parses and validates Gemini's first response. Throws GenerationError with a teacher-readable reason. */
export function parseGenerated(text: string): GeneratedTests {
  const parsed = generatedSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new GenerationError(
      `Gemini's response is missing or has wrong fields: ${parsed.error.issues
        .map((i) => i.path.join('.') || 'response')
        .join(', ')}`,
    );
  }
  const { signature, referenceSolution, smallInputs, generatorScript } = parsed.data;

  if (smallInputs.length !== TEST_COUNTS.small) {
    throw new GenerationError(
      `Gemini returned ${smallInputs.length} small inputs; exactly ${TEST_COUNTS.small} are required`,
    );
  }
  const names = signature.parameters.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new GenerationError('The signature repeats a parameter name');
  }

  const normalised = smallInputs.map((text, i) =>
    normaliseInput(text, signature, `Small input ${i}`),
  );
  if (new Set(normalised).size !== normalised.length) {
    throw new GenerationError('Gemini returned duplicate small inputs');
  }

  return { signature, referenceSolution, smallInputs: normalised, generatorScript };
}

export interface RegeneratedInputs {
  /** index (0-6) -> new compact JSON input */
  replacements: Map<number, string>;
  generatorScript: string | undefined;
}

/**
 * Parses and validates Gemini's answer to a regenerate request. Exactly the requested small
 * indexes must be replaced, and a corrected generator is required when a large index was asked for.
 */
export function parseRegenerated(
  text: string,
  signature: Signature,
  indexes: readonly number[],
  currentSmallInputs: readonly string[],
): RegeneratedInputs {
  const parsed = regeneratedSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new GenerationError("Gemini's replacement response has the wrong fields");
  }

  const wantedSmall = indexes.filter((i) => i < TEST_COUNTS.small).sort((a, b) => a - b);
  const gotSmall = parsed.data.replacements.map((r) => r.index).sort((a, b) => a - b);
  if (wantedSmall.length !== gotSmall.length || wantedSmall.some((v, i) => v !== gotSmall[i])) {
    throw new GenerationError(
      `Gemini replaced inputs [${gotSmall.join(', ')}] but [${wantedSmall.join(', ')}] were requested`,
    );
  }

  const replacements = new Map<number, string>();
  for (const { index, input } of parsed.data.replacements) {
    replacements.set(index, normaliseInput(input, signature, `Replacement for input ${index}`));
  }

  const finalSmall = currentSmallInputs.map((old, i) => replacements.get(i) ?? old);
  if (new Set(finalSmall).size !== finalSmall.length) {
    throw new GenerationError('The replacement inputs duplicate other small inputs');
  }
  for (const [index, input] of replacements) {
    if (input === currentSmallInputs[index]) {
      throw new GenerationError(`Gemini returned the same input again for input ${index}`);
    }
  }

  const wantsLarge = indexes.some((i) => i >= TEST_COUNTS.small);
  const script = parsed.data.generatorScript?.trim();
  if (wantsLarge && !script) {
    throw new GenerationError('Gemini did not return a corrected generator for the large inputs');
  }
  return { replacements, generatorScript: wantsLarge ? script : undefined };
}
