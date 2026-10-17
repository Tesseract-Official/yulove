import { describe, expect, it } from 'vitest';
import { runSetup } from './setup.js';
import { fakeSandbox, ok, run } from './test-utils/fake-sandbox.js';

const SMALL = Array.from({ length: 7 }, (_, i) => JSON.stringify({ n: i }));

const job = (overrides = {}) => ({
  referenceCode: 'REFERENCE',
  generatorCode: 'GENERATOR',
  smallInputs: SMALL,
  largeInputCount: 3,
  timeLimitMs: 1000,
  memoryMb: 128,
  slot: 2,
  ...overrides,
});

/** Generator prints {"n": 100+i}; the reference prints n * 2. Overrides let a test break one step. */
function sandboxWith({ generator = {}, reference = {} } = {}) {
  return fakeSandbox((options) => {
    const file = options.args[0];
    if (file === 'generator.py') {
      const i = Number(options.args[1]);
      return generator[i] ?? ok(JSON.stringify({ n: 100 + i }));
    }
    const n = JSON.parse(options.stdin).n;
    return reference[n] ?? ok(`${n * 2}\n`);
  });
}

describe('runSetup: everything works', () => {
  it('returns all 10 tests and a complete tests.json', async () => {
    const result = await runSetup(job(), { sandbox: sandboxWith() });

    expect(result.complete).toBe(true);
    expect(result.failedInputIndexes).toEqual([]);
    expect(result.reasons).toEqual({});
    expect(result.tests).toHaveLength(10);
    expect(result.tests[0]).toEqual({ index: 0, kind: 'small', input: '{"n":0}', expected: '0' });
    expect(result.tests[6]).toEqual({ index: 6, kind: 'small', input: '{"n":6}', expected: '12' });
    expect(result.tests[7]).toEqual({
      index: 7,
      kind: 'large',
      input: '{"n":100}',
      expected: '200',
    });
    expect(result.tests[9]).toEqual({
      index: 9,
      kind: 'large',
      input: '{"n":102}',
      expected: '204',
    });
    expect(result.testsFile).toEqual({ tests: result.tests });
  });

  it('runs the generator for 0, 1 and 2, then the reference on all 10 inputs', async () => {
    const sandbox = sandboxWith();
    await runSetup(job(), { sandbox });

    const generatorCalls = sandbox.calls.filter((c) => c.args[0] === 'generator.py');
    expect(generatorCalls.map((c) => c.args)).toEqual([
      ['generator.py', '0'],
      ['generator.py', '1'],
      ['generator.py', '2'],
    ]);
    expect(sandbox.calls.filter((c) => c.args[0] === 'reference.py')).toHaveLength(10);
    expect(sandbox.created.find((c) => c.files['generator.py'])?.files['generator.py']).toBe(
      'GENERATOR',
    );
    expect(sandbox.created.find((c) => c.files['reference.py'])?.files['reference.py']).toBe(
      'REFERENCE',
    );
  });

  it('uses the question limits times the Python factor for the reference', async () => {
    const sandbox = sandboxWith();
    await runSetup(job({ timeLimitMs: 2000, memoryMb: 64 }), { sandbox });

    const reference = sandbox.calls.find((c) => c.args[0] === 'reference.py');
    expect(reference.timeoutMs).toBe(6000);
    expect(reference.memoryLimitMb).toBe(64);
    expect(reference.slot).toBe(2);
    expect(reference.command).toBe('python3');
  });

  it('gives the generator its own roomy limits and a larger output cap', async () => {
    const sandbox = sandboxWith();
    await runSetup(job(), { sandbox });

    const generator = sandbox.calls.find((c) => c.args[0] === 'generator.py');
    expect(generator.timeoutMs).toBe(30_000);
    expect(generator.memoryLimitMb).toBe(1024);
    expect(generator.maxOutputBytes).toBe(8 * 1024 * 1024);
    const reference = sandbox.calls.find((c) => c.args[0] === 'reference.py');
    expect(reference.maxOutputBytes).toBe(1024 * 1024);
  });

  it('removes every directory it made', async () => {
    const sandbox = sandboxWith();
    await runSetup(job(), { sandbox });
    expect([...sandbox.removed].sort()).toEqual(sandbox.created.map((c) => c.dir).sort());
    expect(sandbox.created).toHaveLength(13);
  });

  it('stores the expected output as the reference printed it, trimmed', async () => {
    const sandbox = sandboxWith({ reference: { 3: ok('[1, 2, 3]\n') } });
    const result = await runSetup(job(), { sandbox });
    expect(result.tests[3].expected).toBe('[1, 2, 3]');
  });
});

describe('runSetup: a generator index fails', () => {
  it.each([
    [
      'crashes',
      run({ exitCode: 1, stderr: 'Traceback\nValueError: boom' }),
      /crashed: ValueError: boom/,
    ],
    ['times out', run({ killedBy: 'timeout', signal: 'SIGKILL', exitCode: null }), /timed out/],
    ['prints nothing', ok(''), /printed nothing/],
    ['prints invalid JSON', ok('{oops'), /did not print valid JSON/],
    ['prints a list, not an object', ok('[1,2]'), /did not print a JSON object/],
    ['prints a number', ok('5'), /did not print a JSON object/],
    [
      'prints too much',
      run({ killedBy: 'output', outputTruncated: true, stdout: '{"n":' }),
      /printed too much/,
    ],
  ])('index 8 %s', async (_label, generatorResult, reason) => {
    const sandbox = sandboxWith({ generator: { 1: generatorResult } });
    const result = await runSetup(job(), { sandbox });

    expect(result.complete).toBe(false);
    expect(result.failedInputIndexes).toEqual([8]);
    expect(result.reasons[8]).toMatch(/The generator/);
    expect(result.reasons[8]).toMatch(reason);
    expect(result.reasons[8]).toMatch(/large input 1/);
    expect(result.testsFile).toBeNull();
    // Everything else is still produced, and the reference is not run on the missing input.
    expect(result.tests.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
    expect(sandbox.calls.filter((c) => c.args[0] === 'reference.py')).toHaveLength(9);
  });

  it('reports several failed generator indexes together', async () => {
    const sandbox = sandboxWith({
      generator: { 0: run({ exitCode: 1 }), 2: run({ exitCode: 1 }) },
    });
    const result = await runSetup(job(), { sandbox });
    expect(result.failedInputIndexes).toEqual([7, 9]);
  });
});

describe('runSetup: the reference fails', () => {
  it.each([
    [
      'crashes',
      run({ exitCode: 1, stderr: 'ZeroDivisionError: division by zero' }),
      /crashed: ZeroDivisionError/,
    ],
    ['times out', run({ killedBy: 'timeout', signal: 'SIGKILL', exitCode: null }), /timed out/],
    [
      'uses too much memory',
      run({ killedBy: 'memory', signal: 'SIGKILL', exitCode: null }),
      /too much memory/,
    ],
    ['hits the CPU limit', run({ signal: 'SIGXCPU', exitCode: null }), /timed out/],
    ['prints nothing', ok(''), /printed nothing/],
    ['prints two lines', ok('1\n2\n'), /more than one line/],
    ['prints a Python repr', ok("{'a': 1}"), /did not print valid JSON/],
    ['prints NaN', ok('NaN'), /did not print valid JSON/],
  ])('on small input 3 it %s', async (_label, referenceResult, reason) => {
    const sandbox = sandboxWith({ reference: { 3: referenceResult } });
    const result = await runSetup(job(), { sandbox });

    expect(result.complete).toBe(false);
    expect(result.failedInputIndexes).toEqual([3]);
    expect(result.reasons[3]).toMatch(/The reference solution/);
    expect(result.reasons[3]).toMatch(reason);
    expect(result.testsFile).toBeNull();
    expect(result.tests).toHaveLength(9);
  });

  it('fails a large input when the reference cannot handle it', async () => {
    const sandbox = sandboxWith({
      reference: { 101: run({ killedBy: 'timeout', signal: 'SIGKILL', exitCode: null }) },
    });
    const result = await runSetup(job(), { sandbox });
    expect(result.failedInputIndexes).toEqual([8]);
    expect(result.reasons[8]).toMatch(/input 8/);
  });

  it('lists failures from both steps in index order', async () => {
    const sandbox = sandboxWith({
      generator: { 2: run({ exitCode: 1 }) },
      reference: { 5: run({ exitCode: 1 }), 0: run({ exitCode: 1 }) },
    });
    const result = await runSetup(job(), { sandbox });

    expect(result.failedInputIndexes).toEqual([0, 5, 9]);
    expect(Object.keys(result.reasons)).toEqual(['0', '5', '9']);
  });
});
