import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IO_CONVENTION } from './questions.js';

const design = readFileSync(
  fileURLToPath(new URL('../../../docs/DESIGN.md', import.meta.url)),
  'utf8',
);

describe('input/output convention', () => {
  it('is stated word for word in docs/DESIGN.md', () => {
    for (const sentence of IO_CONVENTION) {
      expect(design, sentence).toContain(sentence);
    }
  });

  it('sits in "Question setup and exam PDF", after the numbered list and before the status line', () => {
    const section = design.slice(
      design.indexOf('## Question setup and exam PDF'),
      design.indexOf('## Grading pipeline'),
    );
    const lastStep = section.indexOf('6. **Generate the PDF:**');
    const convention = section.indexOf('Input/output convention:');
    const compare = section.indexOf('The worker compares parsed JSON values');
    const status = section.indexOf('Question test status:');

    expect(lastStep).toBeGreaterThan(-1);
    expect(convention).toBeGreaterThan(lastStep);
    expect(compare).toBeGreaterThan(convention);
    expect(status).toBeGreaterThan(compare);
  });

  it('says what the convention requires', () => {
    expect(IO_CONVENTION[0]).toMatch(/one JSON object keyed by the signature's parameter names/);
    expect(IO_CONVENTION[0]).toMatch(/reference or student driver/);
    expect(IO_CONVENTION[0]).toMatch(/one line of JSON/);
    expect(IO_CONVENTION[1]).toMatch(/parsed JSON values/);
    expect(IO_CONVENTION[1]).toMatch(/2 vs 2\.0/);
  });
});
