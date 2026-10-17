import { describe, expect, it } from 'vitest';
import { classifyRun, containsUnchanged, DETAIL_CHARS, judge, JudgeError } from './judge.js';
import { fakeSandbox, ok, run } from './test-utils/fake-sandbox.js';

const STUDENT = 'def solve(nums):\n    return sum(nums)';
const DRIVER = `import json, sys\n${STUDENT}\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`;

const tests = (n = 10) =>
  Array.from({ length: n }, (_, index) => ({
    index,
    kind: index < 7 ? 'small' : 'large',
    input: `{"nums":[${index}]}`,
    expected: String(index),
  }));

const job = (overrides = {}) => ({
  language: 'python',
  driverCode: DRIVER,
  correctedCode: STUDENT,
  tests: tests(),
  timeLimitMs: 1000,
  memoryMb: 64,
  compareMode: 'EXACT',
  slot: 3,
  ...overrides,
});

/** A sandbox whose compile succeeds and whose runs echo the expected output (every test passes). */
const passing = () =>
  fakeSandbox((options, { index }) => {
    if (index === 0) return run();
    return ok(JSON.parse(options.stdin).nums[0].toString());
  });

describe('containsUnchanged', () => {
  it('finds the code unchanged', () => {
    expect(containsUnchanged(DRIVER, STUDENT)).toBe(true);
  });

  it.each([
    ['CRLF line endings in the driver', DRIVER.replace(/\n/g, '\r\n'), STUDENT],
    ['CRLF line endings in the code', DRIVER, STUDENT.replace(/\n/g, '\r\n')],
    ['blank space around the code', DRIVER, `\n\n  ${STUDENT}  \n`],
  ])('ignores %s', (_label, program, code) => {
    expect(containsUnchanged(program, code)).toBe(true);
  });

  it.each([
    ['a changed operator', DRIVER.replace('sum(nums)', 'max(nums)')],
    ['changed indentation', DRIVER.replace('    return', '  return')],
    ['a renamed variable', DRIVER.replace(/nums/g, 'xs')],
    ['a missing line', DRIVER.replace('    return sum(nums)\n', '')],
    [
      'an added line inside',
      DRIVER.replace('def solve(nums):', 'def solve(nums):\n    nums = nums[:1]'),
    ],
    ['different case', DRIVER.replace('def solve', 'def Solve')],
  ])('notices %s', (_label, program) => {
    expect(containsUnchanged(program, STUDENT)).toBe(false);
  });

  it('refuses an empty correctedCode', () => {
    expect(containsUnchanged(DRIVER, '')).toBe(false);
    expect(containsUnchanged(DRIVER, '  \n ')).toBe(false);
  });
});

describe('DRIVER_MISMATCH', () => {
  it('fails the answer without running anything', async () => {
    const sandbox = passing();
    const result = await judge(job({ driverCode: DRIVER.replace('sum', 'max') }), { sandbox });

    expect(result).toEqual({ outcome: 'FAILED', failReason: 'DRIVER_MISMATCH' });
    expect(sandbox.created).toEqual([]);
    expect(sandbox.calls).toEqual([]);
  });
});

describe('a passing answer', () => {
  it('returns AC for all 10 tests, with no detail', async () => {
    const result = await judge(job(), { sandbox: passing() });

    expect(result.outcome).toBe('COMPLETED');
    expect(result.verdicts).toHaveLength(10);
    expect(result.verdicts.every((v) => v.verdict === 'AC')).toBe(true);
    expect(result.verdicts[0]).toEqual({ index: 0, kind: 'small', verdict: 'AC' });
    expect(result.verdicts[9]).toEqual({ index: 9, kind: 'large', verdict: 'AC' });
  });

  it('compiles once, then runs each test in its own fresh directory', async () => {
    const sandbox = passing();
    await judge(job(), { sandbox });

    expect(sandbox.calls).toHaveLength(11); // 1 compile + 10 tests
    expect(sandbox.calls[0].args).toEqual(['-m', 'py_compile', 'main.py']);
    expect(sandbox.created[0].files).toEqual({ 'main.py': DRIVER });

    const runDirs = sandbox.calls.slice(1).map((c) => c.dir);
    expect(new Set(runDirs).size).toBe(10);
    expect(runDirs).not.toContain(sandbox.calls[0].dir);
  });

  it('copies only the build artifacts into each test directory', async () => {
    const sandbox = fakeSandbox((o, { index }) => (index === 0 ? run() : ok('0')));
    await judge(
      job({ language: 'java', driverCode: `class Main {}\n${STUDENT}`, tests: tests(2) }),
      {
        sandbox,
      },
    );

    // Class files only: not Main.java or notes.txt.
    expect(sandbox.copied).toHaveLength(2);
    for (const copy of sandbox.copied) {
      expect([...copy.names].sort()).toEqual(['Main$Node.class', 'Main.class']);
      expect(copy.from).toBe(sandbox.created[0].dir);
    }
  });

  it('runs the program with the question limits times the language factor', async () => {
    const sandbox = passing();
    await judge(job({ timeLimitMs: 1000, memoryMb: 64 }), { sandbox });

    const first = sandbox.calls[1];
    expect(first.timeoutMs).toBe(3000); // Python 3x
    expect(first.memoryLimitMb).toBe(64);
    expect(first.slot).toBe(3);
    expect(first.stdin).toBe('{"nums":[0]}');
    expect(first.limits).toMatchObject({ nproc: 256, cpuSeconds: 4 });
  });

  it.each([
    ['cpp', 1000, 64, './main', undefined],
    ['go', 1000, 80, './main', { GOMEMLIMIT: '64MiB' }],
    ['java', 2000, 64 + 64, 'java', {}],
  ])('%s: wall %i ms, memory kill at %i MB', async (language, wall, kill, command, env) => {
    const sandbox = fakeSandbox((o, { index }) => (index === 0 ? run() : ok('0')));
    await judge(job({ language, driverCode: `X\n${STUDENT}`, tests: tests(1) }), { sandbox });

    const call = sandbox.calls[1];
    expect(call.timeoutMs).toBe(wall);
    expect(call.memoryLimitMb).toBe(kill);
    expect(call.command).toBe(command);
    if (env) expect(call.extraEnv).toEqual(env);
    if (language === 'java') expect(call.args).toContain('-Xmx64m');
  });

  it('removes every directory it made, the build directory last', async () => {
    const sandbox = passing();
    await judge(job(), { sandbox });

    expect([...sandbox.removed].sort()).toEqual(sandbox.created.map((c) => c.dir).sort());
    expect(sandbox.removed.at(-1)).toBe(sandbox.created[0].dir);
  });

  it('removes the directories even when the sandbox throws', async () => {
    const sandbox = fakeSandbox((o, { index }) => {
      if (index === 3) throw new Error('boom');
      return index === 0 ? run() : ok('0');
    });

    await expect(judge(job(), { sandbox })).rejects.toThrow('boom');
    expect(sandbox.removed.sort()).toEqual(sandbox.created.map((c) => c.dir).sort());
  });
});

describe('compile errors', () => {
  it.each([
    ['a non-zero exit', run({ exitCode: 1, stderr: 'error: expected ;' })],
    ['a timeout', run({ exitCode: null, signal: 'SIGKILL', killedBy: 'timeout' })],
    ['running out of memory', run({ exitCode: null, signal: 'SIGKILL', killedBy: 'memory' })],
  ])('%s fails every test with CE and runs nothing', async (_label, compileResult) => {
    const sandbox = fakeSandbox(() => compileResult);
    const result = await judge(job(), { sandbox });

    expect(result.outcome).toBe('COMPLETED');
    expect(result.verdicts.map((v) => v.verdict)).toEqual(Array(10).fill('CE'));
    expect(sandbox.calls).toHaveLength(1);
  });

  it('keeps input and expected for small CE tests but no actual output', async () => {
    const result = await judge(job(), { sandbox: fakeSandbox(() => run({ exitCode: 1 })) });

    expect(result.verdicts[0]).toEqual({
      index: 0,
      kind: 'small',
      verdict: 'CE',
      input: '{"nums":[0]}',
      expected: '0',
    });
    expect(result.verdicts[8]).toEqual({ index: 8, kind: 'large', verdict: 'CE' });
  });

  it('uses the 20 second compile limit', async () => {
    const sandbox = passing();
    await judge(job(), { sandbox });
    expect(sandbox.calls[0].timeoutMs).toBe(20_000);
  });
});

describe('classifyRun', () => {
  const test = { index: 0, input: '{}', expected: '[1,2]' };
  const classify = (r, extra = {}) =>
    classifyRun(r, test, { compareMode: 'EXACT', language: 'python', ...extra }).verdict;

  it.each([
    ['matching output', ok('[1, 2]\n'), 'AC'],
    ['different output', ok('[2, 1]'), 'WA'],
    ['no output', ok(''), 'WA'],
    ['output that is not JSON', ok('hello'), 'WA'],
    ['two lines of output', ok('[1,2]\n[1,2]'), 'WA'],
    ['a Python repr instead of JSON', ok("[1, 2, 'x']"), 'WA'],
    ['a wall-clock kill', run({ killedBy: 'timeout', signal: 'SIGKILL', exitCode: null }), 'TLE'],
    ['the CPU limit signal', run({ signal: 'SIGXCPU', exitCode: null }), 'TLE'],
    ['a memory kill', run({ killedBy: 'memory', signal: 'SIGKILL', exitCode: null }), 'MLE'],
    ['too much output', run({ killedBy: 'output', outputTruncated: true, stdout: '[1,' }), 'WA'],
    ['a non-zero exit', run({ exitCode: 1, stderr: 'Traceback' }), 'RE'],
    ['a segfault', run({ exitCode: null, signal: 'SIGSEGV' }), 'RE'],
    ['a non-zero exit with correct-looking output', run({ exitCode: 3, stdout: '[1,2]' }), 'RE'],
  ])('%s -> %s', (_label, result, verdict) => {
    expect(classify(result)).toBe(verdict);
  });

  it('time wins over memory when the time fired first', () => {
    expect(classify(run({ killedBy: 'timeout', signal: 'SIGKILL', exitCode: null }))).toBe('TLE');
  });

  it.each([
    ['java', 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space', 'MLE'],
    ['java', 'Exception in thread "main" java.lang.NullPointerException', 'RE'],
    ['go', 'fatal error: runtime: out of memory', 'MLE'],
    ['go', 'panic: runtime error: index out of range', 'RE'],
    ['cpp', 'terminate called after throwing an instance of std::bad_alloc', 'MLE'],
    ['python', 'MemoryError', 'MLE'],
  ])('%s stderr %j -> %s', (language, stderr, verdict) => {
    expect(classify(run({ exitCode: 1, stderr }), { language })).toBe(verdict);
  });

  it('applies the compare mode', () => {
    expect(classify(ok('[2,1]'), { compareMode: 'ANY_ORDER' })).toBe('AC');
    expect(classify(ok('[1.0000001, 2]'), { compareMode: 'FLOAT' })).toBe('AC');
    expect(classify(ok('[1.0000001, 2]'), { compareMode: 'EXACT' })).toBe('WA');
  });

  it('treats an invalid expected output as a bug in the tests, not a wrong answer', () => {
    expect(() =>
      classifyRun(
        ok('1'),
        { index: 4, input: '{}', expected: 'oops' },
        { compareMode: 'EXACT', language: 'python' },
      ),
    ).toThrow(JudgeError);
  });
});

describe('verdict details', () => {
  const failingSandbox = (output) =>
    fakeSandbox((o, { index }) => (index === 0 ? run() : ok(output)));

  it('runs all 10 tests even after failures', async () => {
    const sandbox = failingSandbox('wrong');
    const result = await judge(job(), { sandbox });

    expect(sandbox.calls).toHaveLength(11);
    expect(result.verdicts.map((v) => v.verdict)).toEqual(Array(10).fill('WA'));
  });

  it('keeps input, expected and actual for failed small tests only', async () => {
    const result = await judge(job(), { sandbox: failingSandbox('"wrong"\n') });

    expect(result.verdicts[2]).toEqual({
      index: 2,
      kind: 'small',
      verdict: 'WA',
      input: '{"nums":[2]}',
      expected: '2',
      actual: '"wrong"\n',
    });
    expect(result.verdicts[7]).toEqual({ index: 7, kind: 'large', verdict: 'WA' });
  });

  it('cuts each detail to 200 characters', async () => {
    const long = 'x'.repeat(5000);
    const bigTests = tests().map((t) => ({ ...t, input: long, expected: JSON.stringify(long) }));
    const result = await judge(job({ tests: bigTests }), {
      sandbox: failingSandbox(JSON.stringify('y'.repeat(5000))),
    });

    const first = result.verdicts[0];
    expect(DETAIL_CHARS).toBe(200);
    expect(first.input).toHaveLength(200);
    expect(first.expected).toHaveLength(200);
    expect(first.actual).toHaveLength(200);
  });

  it('mixes verdicts per test', async () => {
    const sandbox = fakeSandbox((o, { index }) => {
      if (index === 0) return run();
      const test = index - 1;
      if (test === 1) return run({ exitCode: 1 });
      if (test === 2) return run({ killedBy: 'timeout', signal: 'SIGKILL', exitCode: null });
      if (test === 3) return run({ killedBy: 'memory', signal: 'SIGKILL', exitCode: null });
      if (test === 4) return ok('999');
      return ok(String(test));
    });
    const result = await judge(job(), { sandbox });

    expect(result.verdicts.map((v) => v.verdict)).toEqual([
      'AC',
      'RE',
      'TLE',
      'MLE',
      'WA',
      'AC',
      'AC',
      'AC',
      'AC',
      'AC',
    ]);
  });

  it('throws JudgeError when a test has invalid expected output', async () => {
    const bad = tests();
    bad[5] = { ...bad[5], expected: 'oops' };
    await expect(judge(job({ tests: bad }), { sandbox: passing() })).rejects.toThrow(JudgeError);
  });

  it('rejects an unsupported language', async () => {
    await expect(judge(job({ language: 'rust' }), { sandbox: passing() })).rejects.toThrow(
      /Unsupported/,
    );
  });
});
