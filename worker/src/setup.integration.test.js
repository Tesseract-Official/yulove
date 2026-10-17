// Runs question setup with real Python in the sandbox. Runs only inside the worker image.
import { describe, expect, it } from 'vitest';
import { runSetup } from './setup.js';

const enabled = process.env.WORKER_SANDBOX_TESTS === '1';
const sandboxDescribe = describe.skipIf(!enabled);

const REFERENCE = `import json, sys

def solve(nums):
    return sum(nums)

print(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))
`;

const GENERATOR = `import json, sys

i = int(sys.argv[1])
print(json.dumps({"nums": list(range(1000 * (i + 1)))}))
`;

const SMALL = Array.from({ length: 7 }, (_, i) =>
  JSON.stringify({ nums: Array.from({ length: i }, (_, k) => k) }),
);

const setupJob = (overrides = {}) => ({
  referenceCode: REFERENCE,
  generatorCode: GENERATOR,
  smallInputs: SMALL,
  largeInputCount: 3,
  timeLimitMs: 1000,
  memoryMb: 128,
  slot: 1,
  ...overrides,
});

sandboxDescribe('setup in the sandbox', () => {
  it('generates the large inputs and computes expected outputs for all 10', async () => {
    const result = await runSetup(setupJob());

    expect(result.complete).toBe(true);
    expect(result.failedInputIndexes).toEqual([]);
    expect(result.tests).toHaveLength(10);
    expect(result.tests.slice(0, 7).map((t) => t.kind)).toEqual(Array(7).fill('small'));
    expect(result.tests.slice(7).map((t) => t.kind)).toEqual(['large', 'large', 'large']);
    // 0+1+...+(n-1) for n = 1000, 2000, 3000
    expect(result.tests.slice(7).map((t) => t.expected)).toEqual(['499500', '1999000', '4498500']);
    expect(result.tests[3]).toEqual({ index: 3, kind: 'small', input: SMALL[3], expected: '3' });
    expect(JSON.parse(result.tests[9].input).nums).toHaveLength(3000);
    expect(result.testsFile).toEqual({ tests: result.tests });
  });

  it('reports a generator index that crashes, and still produces the rest', async () => {
    const generatorCode = GENERATOR.replace(
      'i = int(sys.argv[1])\n',
      'i = int(sys.argv[1])\nif i == 1:\n    raise RuntimeError("generator crashed")\n',
    );

    const result = await runSetup(setupJob({ generatorCode }));

    expect(result.complete).toBe(false);
    expect(result.failedInputIndexes).toEqual([8]);
    expect(result.reasons[8]).toMatch(/generator crashed for large input 1|The generator crashed/);
    expect(result.reasons[8]).toContain('RuntimeError: generator crashed');
    expect(result.testsFile).toBeNull();
    expect(result.tests.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
  });

  it('reports inputs the reference solution cannot handle', async () => {
    const referenceCode = REFERENCE.replace(
      'def solve(nums):',
      'def solve(nums):\n    if len(nums) == 4:\n        raise ValueError("bad input")',
    );

    const result = await runSetup(setupJob({ referenceCode }));

    expect(result.failedInputIndexes).toEqual([4]);
    expect(result.reasons[4]).toMatch(/The reference solution crashed.*ValueError: bad input/);
  });

  it('reports a reference solution that takes too long on a large input', async () => {
    // Fast on small inputs, slow once there are more than 2000 numbers (large input 2 and up).
    const referenceCode = REFERENCE.replace(
      'def solve(nums):',
      'def solve(nums):\n    if len(nums) > 2500:\n        while True:\n            pass',
    );

    const result = await runSetup(setupJob({ referenceCode, timeLimitMs: 300 }));

    expect(result.failedInputIndexes).toEqual([9]);
    expect(result.reasons[9]).toMatch(/timed out/);
  });

  it('reports a generator that prints something other than a JSON object', async () => {
    const result = await runSetup(setupJob({ generatorCode: 'print("[1, 2, 3]")' }));

    expect(result.failedInputIndexes).toEqual([7, 8, 9]);
    expect(result.reasons[7]).toMatch(/did not print a JSON object/);
  });

  it('reports a reference solution that prints more than one line', async () => {
    const referenceCode = 'print(1)\nprint(2)\n';
    const result = await runSetup(setupJob({ referenceCode }));
    expect(result.failedInputIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.reasons[0]).toMatch(/more than one line/);
  });
});
