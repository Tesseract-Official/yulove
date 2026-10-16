import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PromptSection = 'generate' | 'regenerate';

/**
 * Reads prompts/testgen.md. In the Lambda the file is copied next to the bundle at build time,
 * so by default it is read from the bundle's own directory.
 */
export function loadPromptFile(path = join(__dirname, 'testgen.md')): string {
  return readFileSync(path, 'utf8');
}

/** The text of one `<!-- section: name -->` block. */
export function extractSection(markdown: string, section: PromptSection): string {
  const parts = markdown.split(/<!-- section: (\w+) -->/);
  // parts = [preamble, name1, body1, name2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === section) return (parts[i + 1] ?? '').trim();
  }
  throw new Error(`The prompt file has no "${section}" section`);
}

/** Replaces every {{name}}. A placeholder with no value is an error, so nothing is sent half-filled. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`No value for the prompt placeholder {{${name}}}`);
    return value;
  });
}

export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string))];
}
