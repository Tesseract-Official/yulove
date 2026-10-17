// These tests start real processes as the runner users, so they need root, the runner users and the
// toolchains: they only run inside the worker image (it sets WORKER_SANDBOX_TESTS=1).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPILE_LIMITS, RUN_LIMITS } from './languages.js';
import {
  createRunDir,
  killSlotProcesses,
  processesOfUid,
  removeRunDir,
  runSandboxed,
  slotIds,
  WORK_ROOT,
} from './sandbox.js';

const enabled = process.env.WORKER_SANDBOX_TESTS === '1';
const sandboxDescribe = describe.skipIf(!enabled);

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeRunDir(dir)));
  for (const slot of [1, 2]) await killSlotProcesses(slot);
});

/** Makes a run directory holding `probe.py` and runs it as `slot`. */
async function python(
  source,
  { slot = 1, stdin = '', timeoutMs = 10_000, memoryLimitMb = 256, limits, ...rest } = {},
) {
  const dir = await createRunDir(slot, { 'probe.py': source });
  dirs.push(dir);
  const result = await runSandboxed({
    slot,
    dir,
    command: 'python3',
    args: ['probe.py'],
    stdin,
    timeoutMs,
    memoryLimitMb,
    limits: limits ?? { ...RUN_LIMITS, cpuSeconds: 20 },
    ...rest,
  });
  return { dir, result };
}

sandboxDescribe('sandbox: who the program runs as', () => {
  it('runs as the slot’s runner user, not root, in its own directory', async () => {
    const { dir, result } = await python(
      'import json, os\nprint(json.dumps({"uid": os.getuid(), "gid": os.getgid(), "euid": os.geteuid(), "groups": os.getgroups(), "cwd": os.getcwd()}))',
      { slot: 3 },
    );
    const info = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(info.uid).toBe(2003);
    expect(info.euid).toBe(2003);
    expect(info.gid).toBe(2003);
    expect(info.groups.filter((g) => g === 0)).toEqual([]); // no root group left over
    expect(info.cwd).toBe(dir);
  });

  it('gives every slot its own uid: runner1..runner8 are 2001..2008', () => {
    expect(slotIds(1)).toEqual({ uid: 2001, gid: 2001 });
    expect(slotIds(8)).toEqual({ uid: 2008, gid: 2008 });
    expect(() => slotIds(0)).toThrow();
    expect(() => slotIds(9)).toThrow();
  });

  it('makes the run directory owned by the runner with mode 700', async () => {
    const dir = await createRunDir(4, { 'a.txt': 'x' });
    dirs.push(dir);
    const info = await stat(dir);

    expect(info.uid).toBe(2004);
    expect(info.gid).toBe(2004);
    expect(info.mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'a.txt'))).uid).toBe(2004);
    expect(dir.startsWith(`${WORK_ROOT}/`)).toBe(true);
  });

  it('deletes the directory afterwards', async () => {
    const dir = await createRunDir(1);
    await removeRunDir(dir);
    await expect(stat(dir)).rejects.toThrow();
  });
});

sandboxDescribe('sandbox: the environment', () => {
  it('has only PATH, HOME and TMPDIR (plus what the language adds)', async () => {
    const { dir, result } = await python('import json, os\nprint(json.dumps(dict(os.environ)))');
    const env = JSON.parse(result.stdout);

    expect(env.HOME).toBe(dir);
    expect(env.TMPDIR).toBe(dir);
    expect(env.PATH).toContain('/usr/bin');
    // Python itself may add a locale variable; nothing else is allowed.
    expect(
      Object.keys(env)
        .filter((k) => !['LC_CTYPE'].includes(k))
        .sort(),
    ).toEqual(['HOME', 'PATH', 'TMPDIR']);
  });

  it('never shows the child any AWS_* variable, even when the worker has them', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
    process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret';
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/fake';

    const { result } = await python(
      'import json, os\nprint(json.dumps(sorted(k for k in os.environ if k.startswith("AWS"))))',
    );

    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stdout).not.toContain('fake');
  });

  it('cannot read the worker’s environment through /proc', async () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-that-programs-must-never-see';
    const { result } = await python(
      [
        'import json, os',
        'def attempt(pid):',
        '    try:',
        '        return open(f"/proc/{pid}/environ", "rb").read().decode("latin1")',
        '    except OSError as e:',
        '        return "denied: " + e.__class__.__name__',
        'print(json.dumps({"parent": attempt(os.getppid()), "worker": attempt(PID)}))',
      ]
        .join('\n')
        .replace('PID', String(process.pid)),
    );
    const out = JSON.parse(result.stdout);

    expect(out.worker).toBe('denied: PermissionError');
    expect(result.stdout).not.toContain('fake-secret');
  });

  it('passes extra variables only when asked (GOMEMLIMIT for Go)', async () => {
    const { result } = await python('import os\nprint(os.environ.get("GOMEMLIMIT", "unset"))', {
      extraEnv: { GOMEMLIMIT: '64MiB' },
    });
    expect(result.stdout.trim()).toBe('64MiB');
  });
});

sandboxDescribe('sandbox: files', () => {
  it('can write inside its own directory', async () => {
    const { result } = await python(
      'open("note.txt", "w").write("hi")\nprint(open("note.txt").read())',
    );
    expect(result.stdout.trim()).toBe('hi');
  });

  it('cannot write anywhere else, including another runner’s directory', async () => {
    const other = await createRunDir(2, { 'secret.txt': 'runner2 data' });
    dirs.push(other);

    const { result } = await python(
      [
        'import json',
        'def can_write(path):',
        '    try:',
        '        open(path, "w").write("pwned")',
        '        return True',
        '    except OSError:',
        '        return False',
        'def can_read(path):',
        '    try:',
        '        open(path).read()',
        '        return True',
        '    except OSError:',
        '        return False',
        'print(json.dumps({',
        `  "etc": can_write("/etc/pwned"),`,
        '  "usr": can_write("/usr/pwned"),',
        '  "app": can_write("/app/pwned"),',
        '  "work": can_write("/work/pwned"),',
        '  "tmp": can_write("/tmp/pwned"),',
        '  "root": can_write("/pwned"),',
        `  "otherWrite": can_write(${JSON.stringify(join(other, 'pwned'))}),`,
        `  "otherRead": can_read(${JSON.stringify(join(other, 'secret.txt'))}),`,
        '}))',
      ].join('\n'),
    );

    expect(JSON.parse(result.stdout)).toEqual({
      etc: false,
      usr: false,
      app: false,
      work: false,
      tmp: false,
      root: false,
      otherWrite: false,
      otherRead: false,
    });
    expect(await readFile(join(other, 'secret.txt'), 'utf8')).toBe('runner2 data');
  });

  it('cannot create a file larger than the file size limit', async () => {
    const { result } = await python(
      'f = open("big.bin", "wb")\nf.write(b"x" * (20 * 1024 * 1024))\nf.flush()\nprint("wrote it")',
      {
        limits: { ...RUN_LIMITS, cpuSeconds: 20 }, // 16 MB file size limit
      },
    );
    expect(result.stdout).not.toContain('wrote it');
    expect(result.exitCode === 0).toBe(false);
  });
});

sandboxDescribe('sandbox: the JSON libraries in /opt/judge', () => {
  it('are readable by a runner but not writable, and cannot be replaced', async () => {
    const { result } = await python(
      [
        'import json, os',
        'files = ["/opt/judge/include/nlohmann/json.hpp", "/opt/judge/lib/gson.jar"]',
        'def can(path, mode):',
        '    try:',
        '        open(path, mode).close()',
        '        return True',
        '    except OSError:',
        '        return False',
        'print(json.dumps({',
        '  "read": [can(f, "rb") for f in files],',
        '  "append": [can(f, "ab") for f in files],',
        '  "newFile": can("/opt/judge/lib/evil.jar", "wb"),',
        '  "listable": [os.path.isdir(d) and bool(os.listdir(d)) for d in ["/opt/judge/include/nlohmann", "/opt/judge/lib"]],',
        '  "owners": [os.stat(f).st_uid for f in files],',
        '}))',
      ].join('\n'),
    );

    expect(JSON.parse(result.stdout)).toEqual({
      read: [true, true],
      append: [false, false],
      newFile: false,
      listable: [true, true],
      owners: [0, 0],
    });
  });
});

sandboxDescribe('sandbox: limits', () => {
  it('kills a program that runs too long (the whole group) and reports a timeout', async () => {
    const { result } = await python('while True:\n    pass', { timeoutMs: 700 });

    expect(result.killedBy).toBe('timeout');
    expect(result.signal).toBe('SIGKILL');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(650);
    expect(result.elapsedMs).toBeLessThan(3000);
  });

  it('kills a program that sleeps past the limit too', async () => {
    const { result } = await python('import time\ntime.sleep(30)', { timeoutMs: 500 });
    expect(result.killedBy).toBe('timeout');
  });

  it('kills a program that uses too much memory and reports it', async () => {
    const { result } = await python('hog = []\nwhile True:\n    hog.append(b"x" * 10_000_000)', {
      memoryLimitMb: 64,
      timeoutMs: 20_000,
    });

    expect(result.killedBy).toBe('memory');
    expect(result.peakRssMb).toBeGreaterThan(64);
    expect(result.peakRssMb).toBeLessThan(700); // killed soon after crossing the line
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it('counts the memory of child processes too', async () => {
    const { result } = await python(
      'import subprocess, sys\nsubprocess.run([sys.executable, "-c", "h=[]\\nwhile True: h.append(b\'x\'*10_000_000)"])',
      { memoryLimitMb: 64, timeoutMs: 20_000 },
    );
    expect(result.killedBy).toBe('memory');
  });

  it('records the peak memory of a well-behaved program', async () => {
    const { result } = await python(
      'x = b"x" * 20_000_000\nimport time\ntime.sleep(0.2)\nprint(len(x))',
      {
        memoryLimitMb: 256,
      },
    );
    expect(result.killedBy).toBeNull();
    expect(result.peakRssMb).toBeGreaterThan(15);
  });

  it('caps stdout at 1 MB and stops the program', async () => {
    const { result } = await python(
      'import sys\nwhile True:\n    sys.stdout.write("x" * 100000)\n    sys.stdout.flush()',
      {
        timeoutMs: 20_000,
      },
    );

    expect(result.killedBy).toBe('output');
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it('allows a larger cap when asked (the generator’s)', async () => {
    const { result } = await python('import sys\nsys.stdout.write("x" * (3 * 1024 * 1024))', {
      maxOutputBytes: 8 * 1024 * 1024,
    });
    expect(result.outputTruncated).toBe(false);
    expect(result.stdout.length).toBe(3 * 1024 * 1024);
  });

  it('feeds stdin and captures stdout and stderr', async () => {
    const { result } = await python(
      'import sys\nprint(sys.stdin.read().upper())\nprint("oops", file=sys.stderr)\nsys.exit(3)',
      {
        stdin: 'hello',
      },
    );
    expect(result.stdout.trim()).toBe('HELLO');
    expect(result.stderr.trim()).toBe('oops');
    expect(result.exitCode).toBe(3);
  });

  it('survives a program that exits without reading its input', async () => {
    const { result } = await python('print("done")', { stdin: 'x'.repeat(5_000_000) });
    expect(result.stdout.trim()).toBe('done');
  });

  it('stops a CPU hog by the CPU limit if the wall timer is late', async () => {
    const { result } = await python('while True:\n    pass', {
      timeoutMs: 60_000,
      limits: { ...RUN_LIMITS, cpuSeconds: 1 },
    });
    expect(result.signal).toBe('SIGXCPU');
    expect(result.killedBy).toBeNull();
    expect(result.elapsedMs).toBeLessThan(5000);
  });
});

sandboxDescribe('sandbox: containing misbehaving programs', () => {
  it('contains a fork bomb and leaves nothing running', async () => {
    const { uid } = slotIds(1);
    const { result } = await python('import os\nwhile True:\n    os.fork()', {
      memoryLimitMb: 128,
      timeoutMs: 8000,
    });

    expect(['memory', 'timeout']).toContain(result.killedBy ?? 'exited');
    expect(result.elapsedMs).toBeLessThan(15_000);
    expect(processesOfUid(uid)).toEqual([]);
  });

  it('is still usable on the same slot after a fork bomb', async () => {
    await python('import os\nwhile True:\n    os.fork()', { memoryLimitMb: 128, timeoutMs: 5000 });

    const { result } = await python('print("alive")');
    expect(result.stdout.trim()).toBe('alive');
    expect(result.exitCode).toBe(0);
  });

  it('limits how many processes a program can start', async () => {
    const { result } = await python(
      [
        'import json, os, time',
        'pids = []',
        'try:',
        '    for _ in range(600):',
        '        pid = os.fork()',
        '        if pid == 0:',
        '            time.sleep(5)',
        '            os._exit(0)',
        '        pids.append(pid)',
        'except OSError as e:',
        '    pass',
        'print(json.dumps(len(pids)))',
        'for pid in pids:',
        '    os.kill(pid, 9)',
      ].join('\n'),
      // 255 forked Pythons share their pages, but each one's resident size is counted.
      { memoryLimitMb: 8000 },
    );
    const started = JSON.parse(result.stdout);

    expect(started).toBeGreaterThan(10);
    expect(started).toBeLessThan(RUN_LIMITS.nproc);
  });

  it('kills a program that escapes its process group, without waiting for it', async () => {
    const { uid } = slotIds(1);
    const { result } = await python(
      [
        'import os, sys, time',
        'if os.fork() == 0:',
        '    os.setsid()          # a new session: no longer in the process group',
        '    time.sleep(60)       # holds stdout open',
        '    os._exit(0)',
        'print("parent done")',
      ].join('\n'),
      { timeoutMs: 20_000 },
    );

    expect(result.stdout.trim()).toBe('parent done');
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(processesOfUid(uid)).toEqual([]);
  });

  it('kills background children that stay in the group when the program exits', async () => {
    const { uid } = slotIds(1);
    const { result } = await python(
      'import os, time\nif os.fork() == 0:\n    time.sleep(60)\n    os._exit(0)\nprint("done")',
    );

    expect(result.stdout.trim()).toBe('done');
    expect(processesOfUid(uid)).toEqual([]);
  });

  it('refuses to run an invalid slot', async () => {
    const dir = await createRunDir(1);
    dirs.push(dir);
    expect(() =>
      runSandboxed({
        slot: 9,
        dir,
        command: 'true',
        timeoutMs: 1000,
        memoryLimitMb: 10,
        limits: RUN_LIMITS,
      }),
    ).toThrow(/Slot must be/);
  });
});

sandboxDescribe('sandbox: compiling gets roomier limits', () => {
  it('lets a compile start many threads, which a run may not', async () => {
    expect(COMPILE_LIMITS.nproc).toBeGreaterThan(RUN_LIMITS.nproc);
  });
});
