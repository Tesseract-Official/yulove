import { ValidationError } from '@yulove/shared';
import { describe, expect, it } from 'vitest';
import { MAX_CSV_ROWS, parseStudentCsv } from './csv.js';

const BOM = String.fromCharCode(0xfeff);
const HEADER = 'name,college email,roll number,batch';

describe('parseStudentCsv', () => {
  it('parses rows with their line numbers', () => {
    const rows = parseStudentCsv(`${HEADER}\nAsha,a@college.edu,R1,A\nBilal,b@college.edu,R2,B\n`);
    expect(rows).toEqual([
      { line: 2, name: 'Asha', email: 'a@college.edu', rollNo: 'R1', batch: 'A' },
      { line: 3, name: 'Bilal', email: 'b@college.edu', rollNo: 'R2', batch: 'B' },
    ]);
  });

  it('keeps counting lines across blank lines', () => {
    const rows = parseStudentCsv(
      `${HEADER}\n\nAsha,a@college.edu,R1,A\n\nBilal,b@college.edu,R2,B`,
    );
    expect(rows.map((r) => r.line)).toEqual([3, 5]);
  });

  it('handles CRLF, a BOM and quoted fields with commas', () => {
    const rows = parseStudentCsv(`${BOM}${HEADER}\r\n"Rao, Asha",a@college.edu,R1,A\r\n`);
    expect(rows[0]?.name).toBe('Rao, Asha');
    expect(rows).toHaveLength(1);
  });

  it.each([
    'Name,Email,Roll No,Batch',
    'NAME, College Email , Roll Number , BatchId',
    'name,email address,rollno,batch',
    'batch,roll_number,email,name',
  ])('accepts the header %j', (header) => {
    expect(() => parseStudentCsv(`${header}\nx,y,z,w`)).not.toThrow();
  });

  it('maps columns by header, in any order', () => {
    const [row] = parseStudentCsv('batch,roll number,college email,name\nA,R1,a@college.edu,Asha');
    expect(row).toMatchObject({ name: 'Asha', email: 'a@college.edu', rollNo: 'R1', batch: 'A' });
  });

  it('returns short rows with empty cells instead of failing', () => {
    const [row] = parseStudentCsv(`${HEADER}\nAsha,a@college.edu`);
    expect(row).toMatchObject({ name: 'Asha', rollNo: '', batch: '' });
  });

  it('trims cells', () => {
    const [row] = parseStudentCsv(`${HEADER}\n  Asha ,  a@college.edu , R1 , A `);
    expect(row).toEqual({
      line: 2,
      name: 'Asha',
      email: 'a@college.edu',
      rollNo: 'R1',
      batch: 'A',
    });
  });

  it('returns no rows for a header-only file', () => {
    expect(parseStudentCsv(`${HEADER}\n`)).toEqual([]);
  });

  it.each([
    ['an empty file', ''],
    ['a missing header column', 'name,college email,batch\nx,y,z'],
    ['no header at all', 'Asha,a@college.edu,R1,A'],
    ['broken quoting', `${HEADER}\n"Asha,a@college.edu,R1,A`],
  ])('throws ValidationError for %s', (_label, text) => {
    expect(() => parseStudentCsv(text)).toThrow(ValidationError);
  });

  it('names the missing columns', () => {
    expect(() => parseStudentCsv('name,batch\nx,y')).toThrow(/college email, roll number/);
  });

  it('rejects more than the row limit', () => {
    const body = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `n,e${i}@c.edu,R${i},A`).join(
      '\n',
    );
    expect(() => parseStudentCsv(`${HEADER}\n${body}`)).toThrow(/more than/);
  });

  it('accepts exactly the row limit', () => {
    const body = Array.from({ length: MAX_CSV_ROWS }, (_, i) => `n,e${i}@c.edu,R${i},A`).join('\n');
    expect(parseStudentCsv(`${HEADER}\n${body}`)).toHaveLength(MAX_CSV_ROWS);
  });

  it('rejects a file over 1 MB by bytes, not characters', () => {
    // 'é' is 2 bytes, so 600k of them is 1.2 MB but only 600k characters.
    expect(() => parseStudentCsv(`${HEADER}\n${'é'.repeat(600_000)}`)).toThrow(/1 MB/);
  });
});
