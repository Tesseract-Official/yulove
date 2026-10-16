import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '@yulove/shared/testing';
import { deniedRoles, invoke, makeEvent, userOf } from '../test-utils/events.js';
import { handler } from './import-students.js';

const db = new FakeDb();

const HEADER = 'name,college email,roll number,batch';

function call(email: string, batchId: string, csv: unknown) {
  return invoke(
    handler,
    makeEvent({
      method: 'POST',
      path: `/batches/${batchId}/students/import`,
      email,
      pathParameters: { batchId },
      body: csv === undefined ? undefined : typeof csv === 'string' ? { csv } : csv,
    }),
  );
}

const MANAGER = 'batch-manager@college.edu';

beforeEach(() => {
  db.reset();
  process.env['COLLEGE_DOMAIN'] = 'college.edu';
  db.addBatch('A');
  db.addBatch('B');
  db.addBatch('C');
  db.addUser(userOf('SUPER_ADMIN'));
  db.addUser(userOf('BATCH_MANAGER', { batchIds: ['A', 'B'] }));
  db.addUser(userOf('TEACHER', { batchIds: ['A'] }));
  db.addUser(userOf('STUDENT', { email: 'caller@college.edu', batchId: 'A', rollNo: 'R-CALLER' }));
});

describe('POST /batches/{batchId}/students/import: mixed file', () => {
  beforeEach(() => {
    // Existing accounts the file will collide with.
    db.addUser(
      userOf('STUDENT', {
        email: 'update.me@college.edu',
        name: 'Old Name',
        rollNo: 'R-UPD',
        batchId: 'A',
        active: false,
      }),
    );
    db.addUser(
      userOf('STUDENT', {
        email: 'taken.roll@college.edu',
        name: 'Holder',
        rollNo: 'R-TAKEN',
        batchId: 'A',
      }),
    );
    db.addUser(userOf('TEACHER', { email: 'a.teacher@college.edu', name: 'Teach' }));
    db.addUser(
      userOf('STUDENT', { email: 'in.c@college.edu', name: 'In C', rollNo: 'R-INC', batchId: 'C' }),
    );
  });

  const FILE = [
    HEADER,
    'New One,new.one@college.edu,R1,A', // 2: created
    'Update Me,Update.Me@College.edu,R-UPD,B', // 3: updated, moves A -> B
    'Dup Email,new.one@college.edu,R2,A', // 4: duplicate email in file
    'Dup Roll,dup.roll@college.edu,R1,A', // 5: duplicate roll in file
    'Taken,someone.new@college.edu,R-TAKEN,A', // 6: roll belongs to another student
    'Ghost,ghost@college.edu,R3,NOPE', // 7: unknown batch
    'Outsider,out@gmail.com,R4,A', // 8: wrong domain
    'Lookalike,x@college.edu.evil.com,R5,A', // 9: look-alike domain
    'Elsewhere,else@college.edu,R6,C', // 10: batch exists, caller not assigned
    'Nameless,,R7,A', // 11: missing email
    'Short row,short@college.edu', // 12: missing roll number and batch
    'Staff,a.teacher@college.edu,R8,A', // 13: existing account is a teacher
    'Moved,in.c@college.edu,R-INC,A', // 14: student currently in an unmanaged batch
    'Second,second@college.edu,R9,B', // 15: created in another assigned batch
  ].join('\n');

  it('imports the good rows and reports every bad one with a reason', async () => {
    const { status, body } = await call(MANAGER, 'A', FILE);

    expect(status).toBe(200);
    expect(body.created).toEqual([
      { line: 2, email: 'new.one@college.edu', name: 'New One', rollNo: 'R1', batchId: 'A' },
      { line: 15, email: 'second@college.edu', name: 'Second', rollNo: 'R9', batchId: 'B' },
    ]);
    expect(body.updated).toEqual([
      { line: 3, email: 'update.me@college.edu', name: 'Update Me', rollNo: 'R-UPD', batchId: 'B' },
    ]);
    expect(body.rejected).toEqual([
      {
        line: 4,
        email: 'new.one@college.edu',
        rollNo: 'R2',
        reason: 'Duplicate email in file',
      },
      {
        line: 5,
        email: 'dup.roll@college.edu',
        rollNo: 'R1',
        reason: 'Duplicate roll number in file',
      },
      {
        line: 6,
        email: 'someone.new@college.edu',
        rollNo: 'R-TAKEN',
        reason: 'roll number R-TAKEN already belongs to taken.roll@college.edu',
      },
      { line: 7, email: 'ghost@college.edu', rollNo: 'R3', reason: 'unknown batch NOPE' },
      { line: 8, email: 'out@gmail.com', rollNo: 'R4', reason: 'email must end in @college.edu' },
      {
        line: 9,
        email: 'x@college.edu.evil.com',
        rollNo: 'R5',
        reason: 'email must end in @college.edu',
      },
      { line: 10, email: 'else@college.edu', rollNo: 'R6', reason: 'not assigned to batch C' },
      { line: 11, rollNo: 'R7', reason: 'missing college email' },
      { line: 12, email: 'short@college.edu', reason: 'missing roll number, batch' },
      {
        line: 13,
        email: 'a.teacher@college.edu',
        rollNo: 'R8',
        reason: 'a.teacher@college.edu is a teacher account, not a student',
      },
      {
        line: 14,
        email: 'in.c@college.edu',
        rollNo: 'R-INC',
        reason: 'student is currently in batch C, which you are not assigned to',
      },
    ]);
    expect(body.counts).toEqual({ rows: 14, created: 2, updated: 1, rejected: 11 });
  });

  it('writes only the good rows', async () => {
    await call(MANAGER, 'A', FILE);

    expect(db.users.get('new.one@college.edu')).toEqual({
      email: 'new.one@college.edu',
      role: 'STUDENT',
      name: 'New One',
      rollNo: 'R1',
      batchId: 'A',
      active: true,
    });
    // Update changed name, roll and batch but kept active as it was.
    expect(db.users.get('update.me@college.edu')).toMatchObject({
      name: 'Update Me',
      batchId: 'B',
      active: false,
    });
    for (const email of [
      'dup.roll@college.edu',
      'someone.new@college.edu',
      'ghost@college.edu',
      'out@gmail.com',
      'x@college.edu.evil.com',
      'else@college.edu',
      'short@college.edu',
    ]) {
      expect(db.users.has(email)).toBe(false);
    }
    expect(db.users.get('a.teacher@college.edu')?.role).toBe('TEACHER');
    expect(db.users.get('in.c@college.edu')?.batchId).toBe('C');
    expect(db.users.get('taken.roll@college.edu')?.name).toBe('Holder');
  });

  it('is repeatable: a second upload turns the created rows into updates', async () => {
    await call(MANAGER, 'A', FILE);
    const { body } = await call(MANAGER, 'A', FILE);

    expect(body.created).toEqual([]);
    expect(body.updated.map((r: { line: number }) => r.line)).toEqual([2, 3, 15]);
  });
});

describe('POST /batches/{batchId}/students/import: identity normalisation', () => {
  beforeEach(() => {
    db.addUser(
      userOf('STUDENT', {
        email: 'holder@college.edu',
        name: 'Holder',
        rollNo: '22CS101',
        batchId: 'A',
      }),
    );
  });

  it('rejects a roll number that differs only in case from an existing one', async () => {
    const { body } = await call(MANAGER, 'A', `${HEADER}\nOther,other@college.edu,22cs101,A`);

    expect(body.created).toEqual([]);
    expect(body.rejected).toEqual([
      {
        line: 2,
        email: 'other@college.edu',
        rollNo: '22cs101',
        reason: 'roll number 22CS101 already belongs to holder@college.edu',
      },
    ]);
    expect(db.users.has('other@college.edu')).toBe(false);
  });

  it('lets a student keep their own roll number written in another case', async () => {
    const { body } = await call(
      MANAGER,
      'A',
      `${HEADER}\nHolder Renamed,Holder@College.EDU,22cs101,A`,
    );

    expect(body.rejected).toEqual([]);
    expect(body.updated).toEqual([
      {
        line: 2,
        email: 'holder@college.edu',
        name: 'Holder Renamed',
        rollNo: '22CS101',
        batchId: 'A',
      },
    ]);
  });

  it('stores emails in lower case and roll numbers trimmed in upper case', async () => {
    const { body } = await call(
      MANAGER,
      'A',
      `${HEADER}\n  New Kid , New.Kid@College.EDU ,  22cs777 ,A`,
    );

    expect(body.created).toEqual([
      { line: 2, email: 'new.kid@college.edu', name: 'New Kid', rollNo: '22CS777', batchId: 'A' },
    ]);
    expect(db.users.get('new.kid@college.edu')).toMatchObject({
      email: 'new.kid@college.edu',
      rollNo: '22CS777',
    });
    expect(db.users.has('New.Kid@College.EDU')).toBe(false);
  });

  it('treats emails and roll numbers that differ only in case as duplicates within the file', async () => {
    const csv = [
      HEADER,
      'First,Same@College.edu,r1,A',
      'Second,same@college.edu,R2,A',
      'Third,third@college.edu,R1,A',
    ].join('\n');

    const { body } = await call(MANAGER, 'A', csv);

    expect(body.created.map((r: { line: number }) => r.line)).toEqual([2]);
    expect(body.rejected).toEqual([
      { line: 3, email: 'same@college.edu', rollNo: 'R2', reason: 'Duplicate email in file' },
      {
        line: 4,
        email: 'third@college.edu',
        rollNo: 'R1',
        reason: 'Duplicate roll number in file',
      },
    ]);
  });
});

describe('POST /batches/{batchId}/students/import: duplicates within a file', () => {
  it('keeps the first row and rejects every later duplicate, not just the second', async () => {
    const csv = [
      HEADER,
      'Original,dup@college.edu,R1,A', // 2: kept
      'Copy One,dup@college.edu,R2,A', // 3: same email
      'Copy Two,dup@college.edu,R3,A', // 4: same email again
      'Roll Copy,other@college.edu,R1,A', // 5: same roll as line 2
      'Roll Copy Two,another@college.edu,R1,B', // 6: same roll again, other batch
      'Fine,fine@college.edu,R4,A', // 7: unaffected
    ].join('\n');

    const { status, body } = await call(MANAGER, 'A', csv);

    expect(status).toBe(200);
    expect(body.created.map((r: { line: number }) => r.line)).toEqual([2, 7]);
    expect(body.rejected).toEqual([
      { line: 3, email: 'dup@college.edu', rollNo: 'R2', reason: 'Duplicate email in file' },
      { line: 4, email: 'dup@college.edu', rollNo: 'R3', reason: 'Duplicate email in file' },
      {
        line: 5,
        email: 'other@college.edu',
        rollNo: 'R1',
        reason: 'Duplicate roll number in file',
      },
      {
        line: 6,
        email: 'another@college.edu',
        rollNo: 'R1',
        reason: 'Duplicate roll number in file',
      },
    ]);
    // Only the first row's data was saved.
    expect(db.users.get('dup@college.edu')).toMatchObject({ name: 'Original', rollNo: 'R1' });
    expect(db.users.has('other@college.edu')).toBe(false);
    expect(db.users.has('another@college.edu')).toBe(false);
  });

  it('reports the email reason when a row repeats both the email and the roll number', async () => {
    const csv = [HEADER, 'A,a@college.edu,R1,A', 'A again,a@college.edu,R1,A'].join('\n');

    const { body } = await call(MANAGER, 'A', csv);

    expect(body.rejected).toEqual([
      { line: 3, email: 'a@college.edu', rollNo: 'R1', reason: 'Duplicate email in file' },
    ]);
  });
});

describe('POST /batches/{batchId}/students/import: access', () => {
  const ONE_ROW = `${HEADER}\nAsha,asha@college.edu,R1,A`;

  it('lets a super admin import into any batch', async () => {
    const { status, body } = await call(
      'super-admin@college.edu',
      'C',
      `${HEADER}\nAsha,asha@college.edu,R1,C`,
    );
    expect(status).toBe(200);
    expect(body.counts.created).toBe(1);
  });

  it.each(deniedRoles('BATCH_MANAGER'))('refuses a %s with 403', async (role) => {
    const { status } = await call(
      userOf(role, { batchIds: ['A'], batchId: 'A' }).email,
      'A',
      ONE_ROW,
    );

    expect(status).toBe(403);
    expect(db.users.has('asha@college.edu')).toBe(false);
  });

  it('refuses a batch manager for an unassigned batch with 403 and imports nothing', async () => {
    const { status } = await call(MANAGER, 'C', `${HEADER}\nAsha,asha@college.edu,R1,A`);

    expect(status).toBe(403);
    expect(db.users.has('asha@college.edu')).toBe(false);
  });

  it('answers 404 when the URL batch does not exist', async () => {
    expect((await call('super-admin@college.edu', 'NOPE', ONE_ROW)).status).toBe(404);
  });

  it('lets the URL batch be a gate only: rows may name any batch the manager has', async () => {
    const { body } = await call(MANAGER, 'A', `${HEADER}\nBela,bela@college.edu,R2,B`);
    expect(body.created).toHaveLength(1);
    expect(db.users.get('bela@college.edu')?.batchId).toBe('B');
  });
});

describe('POST /batches/{batchId}/students/import: invalid input', () => {
  // `body` is the request body exactly as sent: a string is sent raw, anything else as JSON.
  it.each([
    ['no body', undefined],
    ['a non-JSON body', 'not json'],
    ['an empty csv', { csv: '' }],
    ['a body without csv', { rows: [] }],
    ['a csv that is not a string', { csv: 5 }],
    ['a missing header column', { csv: 'name,batch\nx,A' }],
    ['no header row', { csv: 'Asha,asha@college.edu,R1,A' }],
    ['broken quoting', { csv: `${HEADER}\n"Asha,asha@college.edu,R1,A` }],
    ['a file over 1 MB', { csv: `${HEADER}\n${'x'.repeat(1_000_001)}` }],
  ])('answers 422 for %s', async (_label, body) => {
    const { status } = await invoke(
      handler,
      makeEvent({
        method: 'POST',
        path: '/batches/A/students/import',
        email: MANAGER,
        pathParameters: { batchId: 'A' },
        body,
      }),
    );

    expect(status).toBe(422);
    expect([...db.users.values()].filter((u) => u.role === 'STUDENT' && u.batchId === 'A')).toEqual(
      [expect.objectContaining({ email: 'caller@college.edu' })],
    );
  });

  it('answers 422 for more rows than the limit', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => `n${i},s${i}@college.edu,R${i},A`).join(
      '\n',
    );
    expect((await call(MANAGER, 'A', `${HEADER}\n${rows}`)).status).toBe(422);
  });

  it('never fails the import because of bad rows alone', async () => {
    const csv = `${HEADER}\n,,,\nx,not-an-email,R1,A\nok,ok@college.edu,R2,A`;
    const { status, body } = await call(MANAGER, 'A', csv);

    expect(status).toBe(200);
    expect(body.counts).toEqual({ rows: 3, created: 1, updated: 0, rejected: 2 });
  });

  it('returns 200 with only rejections when every row is bad', async () => {
    const { status, body } = await call(MANAGER, 'A', `${HEADER}\nx,x@gmail.com,R1,A`);

    expect(status).toBe(200);
    expect(body.counts).toEqual({ rows: 1, created: 0, updated: 0, rejected: 1 });
  });
});
