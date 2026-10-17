import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QuestionItem, Signature } from '@yulove/shared';
import PDFDocument from 'pdfkit';

/** Languages students may use, with the versions the worker runs (docs/DESIGN.md). */
export const ALLOWED_LANGUAGES = ['Python 3.12', 'C++17', 'Java 21', 'Go 1.23'] as const;

export const INSTRUCTION =
  'Write each answer on its own page, write the question number at the top of the page, and write only the function (no input reading or printing).';

export interface PdfQuestion {
  number: number;
  marks: number;
  question: QuestionItem;
}

export interface ExamPdfInput {
  title: string;
  batchName: string;
  /** YYYY-MM-DD */
  date: string;
  questions: PdfQuestion[];
}

export interface RenderedPdf {
  buffer: Buffer;
  pageCount: number;
}

const FONT_FILES = {
  regular: 'DejaVuSans.ttf',
  bold: 'DejaVuSans-Bold.ttf',
  mono: 'DejaVuSansMono.ttf',
} as const;

/**
 * Where the DejaVu fonts are: PDF_FONT_DIR if set, a `fonts` folder next to the bundled Lambda,
 * or the package's assets folder when running from source (tests).
 */
export function resolveFontDir(): string {
  const candidates: string[] = [];
  if (process.env['PDF_FONT_DIR']) candidates.push(process.env['PDF_FONT_DIR']);
  if (typeof __dirname === 'string') candidates.push(join(__dirname, 'fonts'));
  try {
    candidates.push(fileURLToPath(new URL('../../assets/fonts', import.meta.url)));
  } catch {
    // import.meta.url does not exist in the bundled CommonJS build
  }
  const found = candidates.find((dir) => existsSync(join(dir, FONT_FILES.regular)));
  if (!found) throw new Error(`The PDF fonts were not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** `name(param: type, ...) -> returnType`, the function students must write. */
export function signatureText(signature: Signature | undefined): string {
  if (!signature) return '(the function signature has not been generated)';
  const parameters = signature.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
  return `${signature.name}(${parameters}) -> ${signature.returnType}`;
}

const formatMarks = (marks: number) => `${marks} ${marks === 1 ? 'mark' : 'marks'}`;

const MARGIN = 56;

/** Renders the exam paper: the first page has the header, and every question starts a new page. */
export function renderExamPdf(
  input: ExamPdfInput,
  options: { compress?: boolean } = {},
): Promise<RenderedPdf> {
  const fonts = resolveFontDir();
  const font = (kind: keyof typeof FONT_FILES) => join(fonts, FONT_FILES[kind]);

  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    compress: options.compress ?? true,
    font: font('regular'),
    info: { Title: input.title, Subject: `${input.batchName}, ${input.date}` },
  });
  doc.registerFont('regular', font('regular'));
  doc.registerFont('bold', font('bold'));
  doc.registerFont('mono', font('mono'));

  let pageCount = 0;
  const chunks: Buffer[] = [];
  const done = new Promise<RenderedPdf>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pageCount }));
  });

  const contentWidth = doc.page.width - MARGIN * 2;
  const heading = (text: string) => {
    doc.moveDown(0.6).font('bold').fontSize(11).text(text, { width: contentWidth });
    doc.font('regular');
  };
  const body = (text: string) =>
    doc.font('regular').fontSize(11).text(text, { width: contentWidth });
  const code = (text: string) => doc.font('mono').fontSize(10).text(text, { width: contentWidth });

  // Page 1: the header.
  doc.font('bold').fontSize(20).text(input.title, { width: contentWidth });
  doc
    .moveDown(0.3)
    .font('regular')
    .fontSize(11)
    .text(`Batch: ${input.batchName}`, { continued: true });
  doc.text(`     Date: ${input.date}`);
  doc.moveDown(0.6).fontSize(10).text(`Instructions: ${INSTRUCTION}`, { width: contentWidth });
  doc
    .moveDown(0.3)
    .text(`Allowed languages: ${ALLOWED_LANGUAGES.join(', ')}`, { width: contentWidth });
  doc.moveDown(0.8);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(MARGIN + contentWidth, doc.y)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.8);

  input.questions.forEach(({ number, marks, question }, index) => {
    if (index > 0) doc.addPage();

    doc.font('bold').fontSize(15).text(`Question ${number}`, { continued: true });
    doc
      .font('regular')
      .fontSize(11)
      .text(`   [${formatMarks(marks)}]`);
    doc.moveDown(0.3).font('bold').fontSize(13).text(question.title, { width: contentWidth });
    doc.moveDown(0.4);
    body(question.statement);

    heading('Input and output');
    body(question.ioDescription);

    heading('Constraints');
    body(question.constraints);

    heading('Examples');
    question.examples.forEach((example, i) => {
      doc
        .moveDown(0.3)
        .font('regular')
        .fontSize(10)
        .text(`Example ${i + 1}`);
      doc.text('Input:');
      code(example.input);
      doc.font('regular').fontSize(10).text('Output:');
      code(example.output);
      if (example.explanation) {
        doc
          .font('regular')
          .fontSize(10)
          .text(`Explanation: ${example.explanation}`, { width: contentWidth });
      }
    });

    heading('Function to write');
    code(signatureText(question.signature));
    doc
      .moveDown(0.6)
      .font('regular')
      .fontSize(10)
      .text(`Allowed languages: ${ALLOWED_LANGUAGES.join(', ')}`);
  });

  // Footer on every page. The bottom margin is lifted while writing it, or PDFKit would start a page.
  const range = doc.bufferedPageRange();
  pageCount = range.count;
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const margins = doc.page.margins;
    const bottom = margins.bottom;
    margins.bottom = 0;
    doc
      .font('regular')
      .fontSize(8)
      .text(
        `${input.title}  ·  ${input.batchName}  ·  page ${i + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - 36,
        {
          width: contentWidth,
          align: 'center',
          lineBreak: false,
        },
      );
    margins.bottom = bottom;
  }

  doc.end();
  return done;
}
