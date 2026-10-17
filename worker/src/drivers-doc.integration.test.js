// Runs every example in DRIVERS.md through the real judge. Runs only inside the worker image.
import { describe, expect, it } from 'vitest';
import { readDriverExamples } from './drivers-doc.js';
import { judge } from './judge.js';
import { sumTests } from './test-utils/programs.js';

const enabled = process.env.WORKER_SANDBOX_TESTS === '1';
const sandboxDescribe = describe.skipIf(!enabled);

const examples = readDriverExamples();

sandboxDescribe.each(['python', 'cpp', 'java', 'go'])(
  'the %s example in DRIVERS.md',
  (language) => {
    it('compiles and passes', async () => {
      const result = await judge({
        language,
        ...examples[language],
        tests: sumTests([0, 1, 2, 7]),
        timeLimitMs: 1000,
        memoryMb: 256,
        compareMode: 'EXACT',
        slot: 1,
      });

      expect(result.outcome).toBe('COMPLETED');
      expect(result.verdicts.map((v) => v.verdict)).toEqual(['AC', 'AC', 'AC', 'AC']);
    });
  },
);
