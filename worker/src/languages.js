// What the worker needs to know about each supported language: where the source goes, how it is
// compiled and run, how much extra time it gets, and its resource limits.

const MB = 1024 * 1024;

/** Verdicts, as in @yulove/shared. */
export const VERDICTS = Object.freeze({
  AC: 'AC',
  WA: 'WA',
  TLE: 'TLE',
  MLE: 'MLE',
  RE: 'RE',
  CE: 'CE',
});

/** Where the image keeps the JSON libraries for C++ and Java drivers (root-owned, read-only). */
export const JUDGE_ROOT = '/opt/judge';
export const CPP_INCLUDE_DIR = `${JUDGE_ROOT}/include`; // #include <nlohmann/json.hpp>
export const GSON_JAR = `${JUDGE_ROOT}/lib/gson.jar`; // import com.google.gson.*;

/** Compile steps may take this long (docs/DESIGN.md: 20 seconds). */
export const COMPILE_TIMEOUT_MS = 20_000;

/** Compile steps are heavy (javac and go start many threads), so they get roomier limits. */
export const COMPILE_LIMITS = Object.freeze({
  nproc: 1024,
  fsizeMb: 256,
  nofile: 1024,
  cpuSeconds: 40,
  memoryMb: 1024,
});

/** Limits for running a student's program. The CPU limit is added from the time limit. */
export const RUN_LIMITS = Object.freeze({
  nproc: 256, // stops fork bombs: counts processes and threads of the runner user
  fsizeMb: 16, // stops a program filling the disk
  nofile: 256,
});

/**
 * Language table.
 *  - timeFactor: the question's time limit is multiplied by this (docs/DESIGN.md).
 *  - memoryAllowanceMb: added to the question's memory limit when deciding to kill for MLE, for
 *    runtime overhead outside the program's own memory (the JVM, the Go runtime). Java is also
 *    started with -Xmx = the limit and Go with GOMEMLIMIT = the limit.
 *  - artifact: which files in the build directory a test run needs.
 *  - outOfMemory: stderr text that means the runtime itself ran out of memory (an MLE, not an RE).
 */
export const LANGUAGES = Object.freeze({
  python: {
    id: 'python',
    sourceFile: 'main.py',
    timeFactor: 3,
    memoryAllowanceMb: 0,
    // py_compile makes a syntax error a compile error, like the other languages.
    compile: () => ({ command: 'python3', args: ['-m', 'py_compile', 'main.py'], env: {} }),
    artifact: (name) => name === 'main.py',
    run: () => ({ command: 'python3', args: ['main.py'], env: {} }),
    outOfMemory: /MemoryError/,
  },
  cpp: {
    id: 'cpp',
    sourceFile: 'main.cpp',
    timeFactor: 1,
    memoryAllowanceMb: 0,
    compile: () => ({
      command: 'g++',
      args: ['-std=c++17', '-O2', '-pipe', `-I${CPP_INCLUDE_DIR}`, '-o', 'main', 'main.cpp'],
      env: {},
    }),
    artifact: (name) => name === 'main',
    run: () => ({ command: './main', args: [], env: {} }),
    outOfMemory: /std::bad_alloc/,
  },
  java: {
    id: 'java',
    sourceFile: 'Main.java',
    timeFactor: 2,
    memoryAllowanceMb: 64,
    compile: () => ({
      command: 'javac',
      args: ['-cp', GSON_JAR, 'Main.java'],
      env: {},
    }),
    artifact: (name) => name.endsWith('.class'),
    run: ({ memoryMb }) => ({
      command: 'java',
      args: [
        `-Xmx${memoryMb}m`,
        '-Xss64m',
        '-XX:+UseSerialGC',
        '-XX:ActiveProcessorCount=2',
        '-XX:-UsePerfData', // no /tmp/hsperfdata file: the root filesystem is read-only
        '-cp',
        `.:${GSON_JAR}`,
        'Main',
      ],
      env: {},
    }),
    outOfMemory: /java\.lang\.OutOfMemoryError/,
  },
  go: {
    id: 'go',
    sourceFile: 'main.go',
    timeFactor: 1,
    memoryAllowanceMb: 16,
    // The Go build cache goes in HOME, which is the run's own directory.
    compile: () => ({ command: 'go', args: ['build', '-o', 'main', 'main.go'], env: {} }),
    artifact: (name) => name === 'main',
    run: ({ memoryMb }) => ({
      command: './main',
      args: [],
      env: { GOMEMLIMIT: `${memoryMb}MiB` },
    }),
    outOfMemory: /fatal error: runtime: out of memory/,
  },
});

export const LANGUAGE_IDS = Object.freeze(Object.keys(LANGUAGES));

export function getLanguage(id) {
  const language = LANGUAGES[id];
  if (!language) throw new Error(`Unsupported language "${String(id)}"`);
  return language;
}

/** Wall-clock time a test may take: the question's limit times the language factor. */
export function wallTimeLimitMs(language, timeLimitMs) {
  return Math.ceil(timeLimitMs * getLanguage(language).timeFactor);
}

/** Resident memory (MB) past which a run is killed as MLE. */
export function memoryKillThresholdMb(language, memoryMb) {
  return memoryMb + getLanguage(language).memoryAllowanceMb;
}

/** Limits passed to prlimit for one test run. */
export function runLimits(language, timeLimitMs) {
  return {
    ...RUN_LIMITS,
    // Wall time normally fires first; this catches a busy loop even if the wall timer is late.
    cpuSeconds: Math.ceil(wallTimeLimitMs(language, timeLimitMs) / 1000) + 1,
  };
}

export const bytes = (mb) => mb * MB;
