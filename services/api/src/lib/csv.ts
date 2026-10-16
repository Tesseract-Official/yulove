import { ValidationError } from '@yulove/shared';
import { parse } from 'csv-parse/sync';

export const MAX_CSV_BYTES = 1_000_000;
/** Keeps an import inside API Gateway's 30 second limit. */
export const MAX_CSV_ROWS = 2_000;

export interface StudentCsvRow {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  name: string;
  email: string;
  rollNo: string;
  batch: string;
}

type Field = 'name' | 'email' | 'rollNo' | 'batch';

const HEADER_ALIASES: Record<string, Field> = {
  name: 'name',
  studentname: 'name',
  email: 'email',
  collegeemail: 'email',
  emailaddress: 'email',
  rollnumber: 'rollNo',
  rollno: 'rollNo',
  roll: 'rollNo',
  batch: 'batch',
  batchid: 'batch',
};

export const FIELD_LABEL: Record<Field, string> = {
  name: 'name',
  email: 'college email',
  rollNo: 'roll number',
  batch: 'batch',
};

const normaliseHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

interface ParsedRecord {
  record: string[];
  info: { lines: number };
}

/**
 * Parses the student CSV. A header row is required: name, college email, roll number, batch
 * (case, spacing and punctuation are ignored; a few common spellings are accepted).
 * Throws ValidationError (422) for problems with the file as a whole. Problems with single
 * rows are the caller's business, so rows with missing cells come back with empty strings.
 */
export function parseStudentCsv(text: string): StudentCsvRow[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) {
    throw new ValidationError('The CSV is larger than 1 MB');
  }

  let records: ParsedRecord[];
  try {
    records = parse(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      info: true,
    }) as unknown as ParsedRecord[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unreadable';
    throw new ValidationError(`The CSV could not be read: ${detail}`);
  }

  const [headerRecord, ...dataRecords] = records;
  if (!headerRecord) throw new ValidationError('The CSV is empty');

  const columnOf: Partial<Record<Field, number>> = {};
  headerRecord.record.forEach((header, index) => {
    const field = HEADER_ALIASES[normaliseHeader(header)];
    if (field && columnOf[field] === undefined) columnOf[field] = index;
  });

  const missing = (Object.keys(FIELD_LABEL) as Field[]).filter((f) => columnOf[f] === undefined);
  if (missing.length > 0) {
    throw new ValidationError(
      `The CSV header is missing: ${missing.map((f) => FIELD_LABEL[f]).join(', ')}. ` +
        'Expected columns: name, college email, roll number, batch.',
    );
  }

  if (dataRecords.length > MAX_CSV_ROWS) {
    throw new ValidationError(`The CSV has more than ${MAX_CSV_ROWS} rows; split it into files`);
  }

  const cell = (record: string[], field: Field) => record[columnOf[field] as number]?.trim() ?? '';
  return dataRecords.map(({ record, info }) => ({
    line: info.lines,
    name: cell(record, 'name'),
    email: cell(record, 'email'),
    rollNo: cell(record, 'rollNo'),
    batch: cell(record, 'batch'),
  }));
}
