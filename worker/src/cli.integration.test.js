// The shipped fixtures, run through the CLI's own entry point. Runs only inside the worker image.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runFixture } from '../cli.js';

const enabled = process.env.WORKER_SANDBOX_TESTS === '1';
const sandboxDescribe = describe.skipIf(!enabled);

const load = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

sandboxDescribe('cli fixtures', () => {
  it('python-ac: all 10 tests pass', async () => {
    const result = await runFixture(await load('python-ac.json'));
    expect(result.outcome).toBe('COMPLETED');
    expect(result.verdicts.map((v) => v.verdict)).toEqual(Array(10).fill('AC'));
  });

  it('python-wa: all 10 tests fail, small ones with detail', async () => {
    const result = await runFixture(await load('python-wa.json'));
    expect(result.verdicts.map((v) => v.verdict)).toEqual(Array(10).fill('WA'));
    expect(result.verdicts[0]).toMatchObject({
      input: '{"nums":[0]}',
      expected: '0',
      actual: '1\n',
    });
    expect(result.verdicts[9]).not.toHaveProperty('input');
  });

  it('python-driver-mismatch: the answer fails to grade', async () => {
    expect(await runFixture(await load('python-driver-mismatch.json'))).toEqual({
      outcome: 'FAILED',
      failReason: 'DRIVER_MISMATCH',
    });
  });

  it('setup-ok: a complete tests file', async () => {
    const result = await runFixture(await load('setup-ok.json'));
    expect(result.complete).toBe(true);
    expect(result.tests).toHaveLength(10);
  });

  it('setup-generator-crash: index 8 fails', async () => {
    const result = await runFixture(await load('setup-generator-crash.json'));
    expect(result.failedInputIndexes).toEqual([8]);
    expect(result.testsFile).toBeNull();
  });
});

describe('cli', () => {
  it('rejects a fixture of an unknown kind', async () => {
    await expect(runFixture({ kind: 'dance' })).rejects.toThrow(/Unknown fixture kind/);
  });
});
