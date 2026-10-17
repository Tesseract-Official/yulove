// Judges one student answer: builds the program, compiles it, runs the 10 tests, and returns a
// verdict for each.
import { compareOutputs } from './compare.js';
import {
  COMPILE_LIMITS,
  COMPILE_TIMEOUT_MS,
  getLanguage,
  memoryKillThresholdMb,
  runLimits,
  VERDICTS,
  wallTimeLimitMs,
} from './languages.js';
import { sandbox as realSandbox } from './sandbox.js';

/** Failed small tests keep their input, expected and actual output cut to this many characters. */
export const DETAIL_CHARS = 200;
export const SMALL_TEST_COUNT = 7;

/** The expected output of a test is not valid JSON. That is a bug in the tests, not a wrong answer. */
export class JudgeError extends Error {}

const normaliseCode = (code) => code.replace(/\r\n?/g, '\n').trim();

/**
 * Does the assembled program contain the student's corrected code unchanged? Line endings and
 * blank space around the whole piece are ignored; everything inside must match exactly.
 */
export function containsUnchanged(program, correctedCode) {
  const code = normaliseCode(correctedCode);
  return code !== '' && normaliseCode(program).includes(code);
}

const cut = (text) => (text.length > DETAIL_CHARS ? text.slice(0, DETAIL_CHARS) : text);

/**
 * Verdict for one finished run.
 *   killed for time -> TLE      killed for memory -> MLE      output over the cap -> WA
 *   CPU limit signal -> TLE     the runtime ran out of memory, or any other non-zero exit/signal -> MLE / RE
 *   exit 0: compare the output as JSON values -> AC or WA
 */
export function classifyRun(run, test, { compareMode, language }) {
  if (run.killedBy === 'timeout' || run.signal === 'SIGXCPU') return { verdict: VERDICTS.TLE };
  if (run.killedBy === 'memory') return { verdict: VERDICTS.MLE };
  if (run.killedBy === 'output' || run.outputTruncated) return { verdict: VERDICTS.WA };

  if (run.exitCode !== 0 || run.signal) {
    const oom = getLanguage(language).outOfMemory;
    return { verdict: oom?.test(run.stderr) ? VERDICTS.MLE : VERDICTS.RE };
  }

  const result = compareOutputs(test.expected, run.stdout, compareMode);
  if (result.equal) return { verdict: VERDICTS.AC };
  if (result.reason === 'expected-invalid') {
    throw new JudgeError(`Expected output of test ${test.index} is not valid JSON`);
  }
  return { verdict: VERDICTS.WA };
}

function describeTest(test, outcome, run) {
  const kind = test.kind ?? (test.index < SMALL_TEST_COUNT ? 'small' : 'large');
  const verdict = { index: test.index, kind, verdict: outcome.verdict };
  // Only failed small tests keep any detail (large ones could be megabytes).
  if (kind === 'small' && outcome.verdict !== VERDICTS.AC) {
    verdict.input = cut(test.input);
    verdict.expected = cut(test.expected);
    if (run) verdict.actual = cut(run.stdout);
  }
  return verdict;
}

/**
 * @param {object} job
 * @param {string} job.language        python | cpp | java | go
 * @param {string} job.driverCode      a complete program that contains the student's code
 * @param {string} job.correctedCode   the student's code, which must appear unchanged in driverCode
 * @param {{index:number, kind?:string, input:string, expected:string}[]} job.tests
 * @param {number} job.timeLimitMs     before the language factor
 * @param {number} job.memoryMb
 * @param {string} job.compareMode     EXACT | ANY_ORDER | FLOAT
 * @param {number} job.slot            1..8, the runner user to use; the caller keeps slots exclusive
 * @returns {Promise<{outcome:'COMPLETED', verdicts:object[]} | {outcome:'FAILED', failReason:string}>}
 */
export async function judge(job, deps = {}) {
  const sb = deps.sandbox ?? realSandbox;
  const { language, driverCode, correctedCode, tests, timeLimitMs, memoryMb, compareMode, slot } =
    job;
  const lang = getLanguage(language);

  if (!containsUnchanged(driverCode, correctedCode)) {
    return { outcome: 'FAILED', failReason: 'DRIVER_MISMATCH' };
  }

  const buildDir = await sb.createRunDir(slot, { [lang.sourceFile]: driverCode });
  try {
    const compile = lang.compile();
    const built = await sb.runSandboxed({
      slot,
      dir: buildDir,
      command: compile.command,
      args: compile.args,
      timeoutMs: COMPILE_TIMEOUT_MS,
      memoryLimitMb: COMPILE_LIMITS.memoryMb,
      limits: COMPILE_LIMITS,
      extraEnv: compile.env,
    });
    if (built.killedBy || built.exitCode !== 0) {
      // A compile error fails every test.
      return {
        outcome: 'COMPLETED',
        verdicts: tests.map((test) => describeTest(test, { verdict: VERDICTS.CE }, null)),
      };
    }

    const artifacts = await sb.listFiles(buildDir, (name) => lang.artifact(name));
    const run = lang.run({ memoryMb });
    const verdicts = [];

    for (const test of tests) {
      // A fresh directory for every test, so a program cannot leave anything for the next one.
      const dir = await sb.createRunDir(slot);
      try {
        await sb.copyFiles(slot, buildDir, dir, artifacts);
        const result = await sb.runSandboxed({
          slot,
          dir,
          command: run.command,
          args: run.args,
          stdin: test.input,
          timeoutMs: wallTimeLimitMs(language, timeLimitMs),
          memoryLimitMb: memoryKillThresholdMb(language, memoryMb),
          limits: runLimits(language, timeLimitMs),
          extraEnv: run.env,
        });
        verdicts.push(
          describeTest(test, classifyRun(result, test, { compareMode, language }), result),
        );
      } finally {
        await sb.removeRunDir(dir);
      }
    }
    return { outcome: 'COMPLETED', verdicts };
  } finally {
    await sb.removeRunDir(buildDir);
  }
}
