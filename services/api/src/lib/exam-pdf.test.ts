import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuestionItem } from '@yulove/shared';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { questionItem } from '../test-utils/questions.js';
import {
  ALLOWED_LANGUAGES,
  INSTRUCTION,
  renderExamPdf,
  resolveFontDir,
  signatureText,
  type ExamPdfInput,
} from './exam-pdf.js';

/** Reads a PDF back: the text of each page. */
async function readPages(buffer: Buffer): Promise<string[]> {
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    // Spaces between items vary with the layout, so squeeze all white space.
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }
  await task.destroy();
  return pages;
}

const signature = {
  name: 'twoSum',
  parameters: [
    { name: 'nums', type: 'int[]' },
    { name: 'target', type: 'int' },
  ],
  returnType: 'int[]',
};

const question = (title: string, extra: Partial<QuestionItem> = {}): QuestionItem =>
  questionItem({
    questionId: title,
    title,
    testStatus: 'APPROVED',
    signature,
    ...extra,
  });

const fixture: ExamPdfInput = {
  title: 'Data Structures Week 3',
  batchName: 'CSE Batch A',
  date: '2026-10-24',
  questions: [
    {
      number: 1,
      marks: 10,
      question: question('Two Sum', {
        statement: 'Find two numbers in the array that add up to the target.',
        ioDescription: 'Input: an array nums and an integer target. Output: the two indexes.',
        constraints: '2 ≤ n ≤ 100000 and every value is at most 10^9.',
        examples: [
          { input: '{"nums":[2,7,11],"target":9}', output: '[0,1]', explanation: '2 + 7 = 9' },
        ],
      }),
    },
    {
      number: 2,
      marks: 5,
      question: question('Valid Parentheses', {
        statement: 'Decide whether the brackets in a string are balanced.',
        constraints: 'The string has at most 10^4 characters.',
        examples: [
          { input: '{"s":"()[]"}', output: 'true' },
          { input: '{"s":"(]"}', output: 'false' },
        ],
        signature: {
          name: 'isValid',
          parameters: [{ name: 's', type: 'string' }],
          returnType: 'bool',
        },
      }),
    },
    {
      number: 3,
      marks: 7.5,
      question: question('Merge Intervals', {
        statement: 'Merge all overlapping intervals → return the result.',
        examples: [{ input: '{"intervals":[[1,3],[2,6]]}', output: '[[1,6]]' }],
        signature: {
          name: 'merge',
          parameters: [{ name: 'intervals', type: 'int[][]' }],
          returnType: 'int[][]',
        },
      }),
    },
  ],
};

describe('renderExamPdf: a real PDF', () => {
  it('is a valid PDF with one page per question', async () => {
    const { buffer, pageCount } = await renderExamPdf(fixture);

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount).toBe(3);
    expect(await readPages(buffer)).toHaveLength(3);
  });

  it('puts each question on its own page, with its number, marks and title', async () => {
    const pages = await readPages((await renderExamPdf(fixture)).buffer);

    expect(pages[0]).toContain('Question 1');
    expect(pages[0]).toContain('[10 marks]');
    expect(pages[0]).toContain('Two Sum');
    expect(pages[1]).toContain('Question 2');
    expect(pages[1]).toContain('[5 marks]');
    expect(pages[1]).toContain('Valid Parentheses');
    expect(pages[2]).toContain('Question 3');
    expect(pages[2]).toContain('[7.5 marks]');
    expect(pages[2]).toContain('Merge Intervals');

    // A title appears only on its own page.
    expect(pages[0]).not.toContain('Valid Parentheses');
    expect(pages[1]).not.toContain('Merge Intervals');
    expect(pages[2]).not.toContain('Two Sum');
  });

  it('starts with the exam title, batch, date, the instruction and the languages', async () => {
    const [first, second] = await readPages((await renderExamPdf(fixture)).buffer);

    expect(first).toContain('Data Structures Week 3');
    expect(first).toContain('Batch: CSE Batch A');
    expect(first).toContain('Date: 2026-10-24');
    expect(first).toContain(INSTRUCTION);
    expect(first).toContain('Allowed languages: Python 3.12, C++17, Java 21, Go 1.23');
    // The header is on the first page only.
    expect(second).not.toContain(INSTRUCTION);
  });

  it('gives each question its statement, input and output, constraints and examples', async () => {
    const [first, second] = await readPages((await renderExamPdf(fixture)).buffer);

    expect(first).toContain('Find two numbers in the array that add up to the target.');
    expect(first).toContain('Input and output');
    expect(first).toContain('Input: an array nums and an integer target.');
    expect(first).toContain('Constraints');
    expect(first).toContain('Examples');
    expect(first).toContain('Example 1');
    expect(first).toContain('{"nums":[2,7,11],"target":9}');
    expect(first).toContain('[0,1]');
    expect(first).toContain('Explanation: 2 + 7 = 9');
    expect(second).toContain('Example 2');
    expect(second).toContain('{"s":"(]"}');
  });

  it('shows the function to write, with its parameter types and return type', async () => {
    const pages = await readPages((await renderExamPdf(fixture)).buffer);

    expect(pages[0]).toContain('Function to write');
    expect(pages[0]).toContain('twoSum(nums: int[], target: int) -> int[]');
    expect(pages[1]).toContain('isValid(s: string) -> bool');
    expect(pages[2]).toContain('merge(intervals: int[][]) -> int[][]');
  });

  it('lists the allowed languages and versions on every question page', async () => {
    const pages = await readPages((await renderExamPdf(fixture)).buffer);

    for (const page of pages) {
      for (const language of ALLOWED_LANGUAGES) expect(page).toContain(language);
    }
    expect([...ALLOWED_LANGUAGES]).toEqual(['Python 3.12', 'C++17', 'Java 21', 'Go 1.23']);
  });

  it('prints symbols the built-in PDF fonts cannot (≤ → ×)', async () => {
    const pages = await readPages((await renderExamPdf(fixture)).buffer);

    expect(pages[0]).toContain('2 ≤ n ≤ 100000');
    expect(pages[2]).toContain('→');
  });

  it('has a footer with the page number on every page', async () => {
    const pages = await readPages((await renderExamPdf(fixture)).buffer);

    pages.forEach((page, i) => {
      expect(page).toContain(`page ${i + 1} of 3`);
      expect(page).toContain('Data Structures Week 3 · CSE Batch A');
    });
  });

  it('continues a long question onto further pages and still starts the next question on a fresh one', async () => {
    const long = {
      ...fixture,
      questions: [
        {
          ...fixture.questions[0]!,
          question: question('Long One', {
            statement: 'This sentence goes on for a while. '.repeat(400),
          }),
        },
        fixture.questions[1]!,
      ],
    };

    const { buffer, pageCount } = await renderExamPdf(long);
    const pages = await readPages(buffer);

    expect(pageCount).toBeGreaterThan(2);
    expect(pages).toHaveLength(pageCount);
    expect(pages.findIndex((p) => p.includes('Question 2'))).toBeGreaterThan(1);
    expect(pages.at(-1)).toContain('Valid Parentheses');
    expect(pages.at(-1)).toContain(`page ${pageCount} of ${pageCount}`);
  });

  it('renders a single question as a single page', async () => {
    const { pageCount } = await renderExamPdf({ ...fixture, questions: [fixture.questions[0]!] });
    expect(pageCount).toBe(1);
  });

  it('says so when a question has no signature yet', async () => {
    const noSignature = {
      ...fixture,
      questions: [
        { ...fixture.questions[0]!, question: question('No Signature', { signature: undefined }) },
      ],
    };
    const [page] = await readPages((await renderExamPdf(noSignature)).buffer);
    expect(page).toContain('has not been generated');
  });

  it('can leave the content uncompressed', async () => {
    const plain = (await renderExamPdf(fixture, { compress: false })).buffer;
    const packed = (await renderExamPdf(fixture)).buffer;
    expect(plain.length).toBeGreaterThan(packed.length);
  });

  it('does not make the same file twice for different exams', async () => {
    const a = (await renderExamPdf(fixture)).buffer;
    const b = (await renderExamPdf({ ...fixture, title: 'Another exam' })).buffer;
    expect(a.equals(b)).toBe(false);
  });
});

describe('signatureText', () => {
  it('writes name(param: type, ...) -> returnType', () => {
    expect(signatureText(signature)).toBe('twoSum(nums: int[], target: int) -> int[]');
  });

  it('copes with no parameters', () => {
    expect(signatureText({ name: 'size', parameters: [], returnType: 'int' })).toBe(
      'size() -> int',
    );
  });
});

describe('resolveFontDir', () => {
  it('finds the bundled fonts when running from source', () => {
    expect(resolveFontDir()).toMatch(/assets\/fonts$/);
  });

  it('prefers PDF_FONT_DIR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fonts-'));
    try {
      process.env['PDF_FONT_DIR'] = dir; // empty folder: not usable, so it falls through to the next place
      expect(resolveFontDir()).toMatch(/assets\/fonts$/);
      process.env['PDF_FONT_DIR'] = resolveFontDir();
      expect(resolveFontDir()).toBe(process.env['PDF_FONT_DIR']);
    } finally {
      delete process.env['PDF_FONT_DIR'];
      await rm(dir, { recursive: true, force: true });
    }
  });
});
