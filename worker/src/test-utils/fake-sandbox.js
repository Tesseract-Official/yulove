/** Result of a finished run, with sensible defaults. */
export function run(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    killedBy: null,
    outputTruncated: false,
    elapsedMs: 5,
    peakRssMb: 3,
    ...overrides,
  };
}

export const ok = (stdout) => run({ stdout });

/**
 * A sandbox that never starts a process. `handler(options, info)` returns the result of each
 * runSandboxed call; `info.phase` is 'compile' for the first call, 'run' afterwards.
 */
export function fakeSandbox(handler) {
  const created = [];
  const removed = [];
  const copied = [];
  const calls = [];
  let counter = 0;

  return {
    created,
    removed,
    copied,
    calls,
    async createRunDir(slot, files = {}) {
      counter += 1;
      const dir = `/fake/run-${slot}-${counter}`;
      created.push({ dir, slot, files });
      return dir;
    },
    async removeRunDir(dir) {
      removed.push(dir);
    },
    async listFiles(_dir, accept) {
      return ['main', 'main.py', 'Main.class', 'Main$Node.class', 'Main.java', 'notes.txt'].filter(
        accept,
      );
    },
    async copyFiles(slot, from, to, names) {
      copied.push({ slot, from, to, names });
    },
    async runSandboxed(options) {
      calls.push(options);
      return handler(options, { index: calls.length - 1 });
    },
  };
}
