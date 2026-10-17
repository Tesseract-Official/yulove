import { describe, expect, it } from 'vitest';
import {
  COMPILE_LIMITS,
  CPP_INCLUDE_DIR,
  GSON_JAR,
  JUDGE_ROOT,
  COMPILE_TIMEOUT_MS,
  getLanguage,
  LANGUAGE_IDS,
  memoryKillThresholdMb,
  runLimits,
  RUN_LIMITS,
  wallTimeLimitMs,
} from './languages.js';

describe('languages', () => {
  it('supports Python, C++, Java and Go', () => {
    expect([...LANGUAGE_IDS].sort()).toEqual(['cpp', 'go', 'java', 'python']);
  });

  it('rejects anything else', () => {
    expect(() => getLanguage('rust')).toThrow(/Unsupported language/);
    expect(() => getLanguage(undefined)).toThrow(/Unsupported language/);
  });

  it.each([
    ['python', 'main.py'],
    ['cpp', 'main.cpp'],
    ['java', 'Main.java'],
    ['go', 'main.go'],
  ])('%s source file is %s', (id, file) => {
    expect(getLanguage(id).sourceFile).toBe(file);
  });
});

describe('time factors (docs/DESIGN.md: C++ and Go 1x, Java 2x, Python 3x)', () => {
  it.each([
    ['cpp', 1],
    ['go', 1],
    ['java', 2],
    ['python', 3],
  ])('%s is %ix', (id, factor) => {
    expect(getLanguage(id).timeFactor).toBe(factor);
    expect(wallTimeLimitMs(id, 2000)).toBe(2000 * factor);
  });

  it('rounds a fractional result up', () => {
    expect(wallTimeLimitMs('python', 333.5)).toBe(1001);
  });
});

describe('compile commands', () => {
  it('Python checks syntax with py_compile', () => {
    expect(getLanguage('python').compile()).toMatchObject({
      command: 'python3',
      args: ['-m', 'py_compile', 'main.py'],
    });
  });

  it('C++ is C++17 with -O2 and can include nlohmann/json', () => {
    const { command, args } = getLanguage('cpp').compile();
    expect(command).toBe('g++');
    expect(args).toEqual(expect.arrayContaining(['-std=c++17', '-O2', 'main.cpp']));
    expect(args).toContain('-I/opt/judge/include');
    expect(args.at(-1)).toBe('main.cpp');
  });

  it('Java compiles Main.java with Gson on the classpath', () => {
    expect(getLanguage('java').compile()).toMatchObject({
      command: 'javac',
      args: ['-cp', '/opt/judge/lib/gson.jar', 'Main.java'],
    });
  });

  it('keeps the JSON libraries under /opt/judge', () => {
    expect(JUDGE_ROOT).toBe('/opt/judge');
    expect(CPP_INCLUDE_DIR).toBe('/opt/judge/include');
    expect(GSON_JAR).toBe('/opt/judge/lib/gson.jar');
  });

  it('Go builds main.go into ./main', () => {
    expect(getLanguage('go').compile()).toMatchObject({
      command: 'go',
      args: ['build', '-o', 'main', 'main.go'],
    });
  });

  it('compiling has a 20 second limit', () => {
    expect(COMPILE_TIMEOUT_MS).toBe(20_000);
    expect(COMPILE_LIMITS.cpuSeconds).toBeGreaterThan(20);
  });
});

describe('run commands pass the memory limit to the runtime', () => {
  it('Java gets -Xmx', () => {
    const { command, args } = getLanguage('java').run({ memoryMb: 256 });
    expect(command).toBe('java');
    expect(args).toContain('-Xmx256m');
    expect(args.at(-1)).toBe('Main');
  });

  it('Java runs with the current directory and Gson on the classpath', () => {
    const { args } = getLanguage('java').run({ memoryMb: 64 });
    expect(args.slice(-3)).toEqual(['-cp', '.:/opt/judge/lib/gson.jar', 'Main']);
  });

  it('Java does not write a perf-data file', () => {
    expect(getLanguage('java').run({ memoryMb: 64 }).args).toContain('-XX:-UsePerfData');
  });

  it('Go gets GOMEMLIMIT', () => {
    const run = getLanguage('go').run({ memoryMb: 128 });
    expect(run.command).toBe('./main');
    expect(run.env).toEqual({ GOMEMLIMIT: '128MiB' });
  });

  it('Python and C++ have no runtime memory flag and add nothing to the environment', () => {
    expect(getLanguage('python').run({ memoryMb: 64 })).toEqual({
      command: 'python3',
      args: ['main.py'],
      env: {},
    });
    expect(getLanguage('cpp').run({ memoryMb: 64 })).toEqual({
      command: './main',
      args: [],
      env: {},
    });
  });
});

describe('artifacts copied into each test directory', () => {
  it('Java needs every class file, including nested classes', () => {
    const java = getLanguage('java');
    expect(java.artifact('Main.class')).toBe(true);
    expect(java.artifact('Main$Node.class')).toBe(true);
    expect(java.artifact('Main.java')).toBe(false);
  });

  it('C++ and Go need only the binary; Python only the source', () => {
    expect(getLanguage('cpp').artifact('main')).toBe(true);
    expect(getLanguage('cpp').artifact('main.cpp')).toBe(false);
    expect(getLanguage('go').artifact('main')).toBe(true);
    expect(getLanguage('python').artifact('main.py')).toBe(true);
  });
});

describe('limits', () => {
  it('memory kill threshold adds the runtime allowance', () => {
    expect(memoryKillThresholdMb('python', 256)).toBe(256);
    expect(memoryKillThresholdMb('cpp', 256)).toBe(256);
    expect(memoryKillThresholdMb('java', 256)).toBe(256 + 64);
    expect(memoryKillThresholdMb('go', 256)).toBe(256 + 16);
  });

  it('run limits cap processes, file size and open files, and add a CPU limit above the wall time', () => {
    expect(runLimits('python', 2000)).toEqual({ ...RUN_LIMITS, cpuSeconds: 7 });
    expect(runLimits('cpp', 2000)).toEqual({ ...RUN_LIMITS, cpuSeconds: 3 });
    expect(RUN_LIMITS.nproc).toBeLessThanOrEqual(256);
  });
});
