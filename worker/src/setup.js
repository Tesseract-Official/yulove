// Question setup: runs the generator for the large inputs and the reference solution on all 10
// inputs, inside the sandbox, and returns the tests.json content plus the inputs that failed.
import { parseJsonValue } from './compare.js';
import { runLimits, wallTimeLimitMs } from './languages.js';
import { sandbox as realSandbox } from './sandbox.js';

export const SMALL_INPUT_COUNT = 7;
/** The generator is not judged against the question's limits, only kept from running forever. */
export const GENERATOR_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 1024,
  maxOutputBytes: 8 * 1024 * 1024, // a large input may reach about 5 MB
});

const cut = (text, n = 200) => (text.length > n ? `${text.slice(0, n)}...` : text);

/** Runs `python3 <file> [args]` in a fresh run directory and removes the directory afterwards. */
async function runPython(
  sb,
  { slot, file, source, args = [], stdin = '', timeoutMs, memoryMb, cpuSeconds, maxOutputBytes },
) {
  const dir = await sb.createRunDir(slot, { [file]: source });
  try {
    return await sb.runSandboxed({
      slot,
      dir,
      command: 'python3',
      args: [file, ...args],
      stdin,
      timeoutMs,
      memoryLimitMb: memoryMb,
      limits: { nproc: 256, fsizeMb: 16, nofile: 256, cpuSeconds },
      maxOutputBytes,
    });
  } finally {
    await sb.removeRunDir(dir);
  }
}

/** Why a finished run cannot be used, or undefined when it printed one line of JSON and exited 0. */
function problemWith(run, { requireObject = false } = {}) {
  if (run.killedBy === 'timeout' || run.signal === 'SIGXCPU') return 'timed out';
  if (run.killedBy === 'memory') return 'used too much memory';
  if (run.killedBy === 'output' || run.outputTruncated) return 'printed too much';
  if (run.exitCode !== 0 || run.signal) {
    const lastLine = run.stderr.trim().split('\n').pop() ?? '';
    return `crashed${lastLine ? `: ${cut(lastLine)}` : ''}`;
  }
  const text = run.stdout.trim();
  if (text === '') return 'printed nothing';
  if (text.includes('\n')) return 'printed more than one line';
  const parsed = parseJsonValue(text);
  if (!parsed.ok) return 'did not print valid JSON';
  if (
    requireObject &&
    (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value))
  ) {
    return 'did not print a JSON object';
  }
  return undefined;
}

/**
 * @param {object} job
 * @param {string} job.referenceCode   reference.py: reads one JSON object on stdin, prints one line of JSON
 * @param {string} job.generatorCode   generator.py: `python3 generator.py <i>` prints one large input
 * @param {string[]} job.smallInputs   the 7 small inputs (JSON object text)
 * @param {number} job.largeInputCount normally 3
 * @param {number} job.timeLimitMs     the question's limit, before the Python factor
 * @param {number} job.memoryMb
 * @param {number} job.slot
 * @returns {Promise<{complete:boolean, failedInputIndexes:number[], reasons:Record<number,string>,
 *   tests:object[], testsFile:object|null}>}
 */
export async function runSetup(job, deps = {}) {
  const sb = deps.sandbox ?? realSandbox;
  const {
    referenceCode,
    generatorCode,
    smallInputs,
    largeInputCount,
    timeLimitMs,
    memoryMb,
    slot,
  } = job;

  const failed = new Map(); // index -> reason
  const inputs = new Map(); // index -> input text

  smallInputs.forEach((text, i) => inputs.set(i, text));

  // 1. The large inputs, from the generator.
  for (let i = 0; i < largeInputCount; i += 1) {
    const index = smallInputs.length + i;
    const run = await runPython(sb, {
      slot,
      file: 'generator.py',
      source: generatorCode,
      args: [String(i)],
      timeoutMs: GENERATOR_LIMITS.timeoutMs,
      memoryMb: GENERATOR_LIMITS.memoryMb,
      cpuSeconds: Math.ceil(GENERATOR_LIMITS.timeoutMs / 1000) + 1,
      maxOutputBytes: GENERATOR_LIMITS.maxOutputBytes,
    });
    const problem = problemWith(run, { requireObject: true });
    if (problem) failed.set(index, `The generator ${problem} for large input ${i}`);
    else inputs.set(index, run.stdout.trim());
  }

  // 2. The reference solution on every input that exists.
  const tests = [];
  const referenceTimeoutMs = wallTimeLimitMs('python', timeLimitMs);
  const total = smallInputs.length + largeInputCount;
  for (let index = 0; index < total; index += 1) {
    const input = inputs.get(index);
    if (input === undefined) continue; // the generator failed; nothing to run

    const run = await runPython(sb, {
      slot,
      file: 'reference.py',
      source: referenceCode,
      stdin: input,
      timeoutMs: referenceTimeoutMs,
      memoryMb,
      cpuSeconds: runLimits('python', timeLimitMs).cpuSeconds,
      maxOutputBytes: 1024 * 1024,
    });
    const problem = problemWith(run);
    if (problem) {
      failed.set(index, `The reference solution ${problem} on input ${index}`);
      continue;
    }
    tests.push({
      index,
      kind: index < SMALL_INPUT_COUNT ? 'small' : 'large',
      input,
      expected: run.stdout.trim(),
    });
  }

  tests.sort((a, b) => a.index - b.index);
  const failedInputIndexes = [...failed.keys()].sort((a, b) => a - b);
  const complete = failedInputIndexes.length === 0;

  return {
    complete,
    failedInputIndexes,
    reasons: Object.fromEntries(failedInputIndexes.map((i) => [i, failed.get(i)])),
    tests,
    // The content of tests.json; the caller adds questionId and version.
    testsFile: complete ? { tests } : null,
  };
}
