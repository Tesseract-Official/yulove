import { describe, expect, it } from 'vitest';
import { GenerationError, normaliseInput, parseGenerated, parseRegenerated } from './responses.js';

const signature = {
  name: 'twoSum',
  parameters: [
    { name: 'nums', type: 'int[]' },
    { name: 'target', type: 'int' },
  ],
  returnType: 'int[]',
};

const smallInputs = Array.from({ length: 7 }, (_, i) =>
  JSON.stringify({ nums: [i, i + 1], target: i }),
);

const generated = (change: Record<string, unknown> = {}) =>
  JSON.stringify({
    signature,
    referenceSolution: 'print(1)',
    smallInputs,
    generatorScript: 'print(2)',
    ...change,
  });

describe('parseGenerated', () => {
  it('accepts a valid response and compacts the inputs', () => {
    const result = parseGenerated(
      generated({ smallInputs: smallInputs.map((s) => JSON.stringify(JSON.parse(s), null, 2)) }),
    );
    expect(result.smallInputs).toEqual(smallInputs);
    expect(result.signature).toEqual(signature);
  });

  it.each([
    ['malformed JSON', '{not json', /malformed JSON/],
    ['an empty reply', '', /malformed JSON/],
    [
      '6 small inputs',
      generated({ smallInputs: smallInputs.slice(0, 6) }),
      /6 small inputs.*exactly 7/,
    ],
    [
      '8 small inputs',
      generated({ smallInputs: [...smallInputs, '{"nums":[],"target":0}'] }),
      /8 small inputs/,
    ],
    ['no reference solution', generated({ referenceSolution: ' ' }), /missing or has wrong fields/],
    ['no generator', generated({ generatorScript: undefined }), /generatorScript/],
    ['no signature', generated({ signature: undefined }), /signature/],
    [
      'a repeated parameter name',
      generated({
        signature: { ...signature, parameters: [signature.parameters[0], signature.parameters[0]] },
      }),
      /repeats a parameter/,
    ],
    [
      'an input that is not JSON',
      generated({ smallInputs: [...smallInputs.slice(0, 6), 'not json'] }),
      /Small input 6 is not valid JSON/,
    ],
    [
      'an input that is an array',
      generated({ smallInputs: [...smallInputs.slice(0, 6), '[1,2]'] }),
      /must be a JSON object/,
    ],
    [
      'an input with the wrong keys',
      generated({ smallInputs: [...smallInputs.slice(0, 6), '{"nums":[1]}'] }),
      /has keys \[nums\]/,
    ],
    [
      'an input with an extra key',
      generated({ smallInputs: [...smallInputs.slice(0, 6), '{"nums":[1],"target":1,"x":2}'] }),
      /has keys/,
    ],
    [
      'duplicate inputs',
      generated({ smallInputs: [...smallInputs.slice(0, 6), smallInputs[0]] }),
      /duplicate small inputs/,
    ],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseGenerated(text)).toThrow(GenerationError);
    expect(() => parseGenerated(text)).toThrow(message);
  });

  it('treats inputs that differ only in whitespace as duplicates', () => {
    const spaced = [
      ...smallInputs.slice(0, 6),
      JSON.stringify(JSON.parse(smallInputs[0] as string), null, 4),
    ];
    expect(() => parseGenerated(generated({ smallInputs: spaced }))).toThrow(/duplicate/);
  });

  it('accepts keys in any order', () => {
    const shuffled = [...smallInputs.slice(0, 6), '{"target":99,"nums":[1]}'];
    expect(parseGenerated(generated({ smallInputs: shuffled })).smallInputs).toHaveLength(7);
  });
});

describe('normaliseInput', () => {
  it('allows a signature with no parameters and an empty object', () => {
    expect(normaliseInput('{}', { name: 'f', parameters: [], returnType: 'int' }, 'x')).toBe('{}');
  });
});

describe('parseRegenerated', () => {
  const replacementFor = (index: number) => ({
    index,
    input: JSON.stringify({ nums: [100 + index], target: 100 + index }),
  });
  const regen = (body: unknown) => JSON.stringify(body);

  it('accepts replacements for exactly the requested small indexes', () => {
    const result = parseRegenerated(
      regen({ replacements: [replacementFor(4), replacementFor(1)] }),
      signature,
      [1, 4],
      smallInputs,
    );
    expect([...result.replacements.keys()].sort()).toEqual([1, 4]);
    expect(result.generatorScript).toBeUndefined();
  });

  it('requires a generator when a large index is requested, and keeps it', () => {
    const result = parseRegenerated(
      regen({ replacements: [], generatorScript: ' print(3) ' }),
      signature,
      [8],
      smallInputs,
    );
    expect(result.generatorScript).toBe('print(3)');
  });

  it('ignores a generator nobody asked for', () => {
    const result = parseRegenerated(
      regen({ replacements: [replacementFor(0)], generatorScript: 'print(9)' }),
      signature,
      [0],
      smallInputs,
    );
    expect(result.generatorScript).toBeUndefined();
  });

  it.each([
    [
      'an extra replacement',
      { replacements: [replacementFor(1), replacementFor(2)] },
      [1],
      /replaced inputs \[1, 2\]/,
    ],
    [
      'a missing replacement',
      { replacements: [replacementFor(1)] },
      [1, 2],
      /\[1, 2\] were requested/,
    ],
    [
      'a replacement for the wrong index',
      { replacements: [replacementFor(3)] },
      [1],
      /\[3\].*\[1\]/,
    ],
    [
      'the same input again',
      { replacements: [{ index: 1, input: smallInputs[1] }] },
      [1],
      /same input again/,
    ],
    [
      'an input that duplicates another',
      { replacements: [{ index: 1, input: smallInputs[2] }] },
      [1],
      /duplicate/,
    ],
    [
      'an input with the wrong keys',
      { replacements: [{ index: 1, input: '{"nums":[1]}' }] },
      [1],
      /has keys/,
    ],
    ['no generator for a large index', { replacements: [] }, [7], /corrected generator/],
    ['wrong fields', { replacements: 'nope' }, [1], /wrong fields/],
  ])('rejects %s', (_label, body, indexes, message) => {
    expect(() => parseRegenerated(regen(body), signature, indexes, smallInputs)).toThrow(message);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseRegenerated('nope', signature, [1], smallInputs)).toThrow(/malformed JSON/);
  });
});
