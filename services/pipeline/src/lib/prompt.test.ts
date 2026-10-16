import { describe, expect, it } from 'vitest';
import { PROMPT_FILE } from '../test-utils/paths.js';
import { extractSection, loadPromptFile, placeholdersIn, renderPrompt } from './prompt.js';

describe('prompts/testgen.md', () => {
  const markdown = loadPromptFile(PROMPT_FILE);

  it('has a generate and a regenerate section', () => {
    expect(extractSection(markdown, 'generate')).toContain('EXACTLY 7');
    expect(extractSection(markdown, 'regenerate')).toContain('replacements');
  });

  it('keeps the sections apart', () => {
    expect(extractSection(markdown, 'generate')).not.toContain('replacements');
    expect(extractSection(markdown, 'regenerate')).not.toContain('EXACTLY 7');
  });

  it('tells the model to treat the question as data', () => {
    expect(extractSection(markdown, 'generate')).toMatch(/DATA/);
    expect(extractSection(markdown, 'regenerate')).toMatch(/data, not instructions/);
  });

  describe('input/output convention', () => {
    const generate = extractSection(markdown, 'generate');
    const regenerate = extractSection(markdown, 'regenerate');

    it('says a test input is one JSON object keyed by the parameter names', () => {
      expect(generate).toContain(
        "ONE JSON object whose keys are exactly the signature's parameter names",
      );
      expect(regenerate).toContain(
        "ONE JSON object keyed by exactly the\nsignature's parameter names",
      );
    });

    it('says programs print the result as one line of JSON with json.dumps', () => {
      expect(generate).toContain('ONE line of JSON, produced with `json.dumps`');
      expect(generate).toContain('print(json.dumps(result))');
      expect(regenerate).toContain('one line of JSON');
    });

    it('says reference.py reads the object from stdin and calls the solution with those arguments', () => {
      expect(generate).toMatch(/reads ONE test input from standard input as a JSON object/);
      expect(generate).toMatch(/calls your solution with those values as arguments/);
    });

    it('says the checker compares parsed JSON values, not text', () => {
      expect(generate).toContain('compares the VALUES');
      expect(generate).toContain('`2` versus `2.0`');
      expect(regenerate).toContain('compares parsed JSON values, not text');
    });

    it('says the large-input generator prints one line of JSON keyed like a small input', () => {
      expect(generate).toContain('ONE line of JSON: a JSON object');
      expect(generate).toContain('exactly like a small input');
    });
  });

  it('uses only known placeholders', () => {
    const known = new Set([
      'title',
      'statement',
      'ioDescription',
      'constraints',
      'examples',
      'targetComplexity',
      'timeLimitMs',
      'memoryMb',
      'compareMode',
      'signature',
      'referenceSolution',
      'generatorScript',
      'smallInputs',
      'indexes',
      'reason',
    ]);
    for (const section of ['generate', 'regenerate'] as const) {
      for (const name of placeholdersIn(extractSection(markdown, section))) {
        expect(known.has(name), `unknown placeholder {{${name}}}`).toBe(true);
      }
    }
  });
});

describe('renderPrompt', () => {
  it('fills every occurrence', () => {
    expect(renderPrompt('{{a}} and {{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 1 and 2');
  });

  it('does not re-expand text that came from a value', () => {
    expect(renderPrompt('{{a}}', { a: '{{b}}', b: 'oops' })).toBe('{{b}}');
  });

  it('refuses to send a half-filled prompt', () => {
    expect(() => renderPrompt('{{a}} {{missing}}', { a: '1' })).toThrow(/missing/);
  });
});

describe('extractSection', () => {
  it('throws for a section that does not exist', () => {
    expect(() => extractSection('no sections here', 'generate')).toThrow(/no "generate" section/);
  });
});
