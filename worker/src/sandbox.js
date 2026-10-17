// Runs untrusted code as an unprivileged "runner" user, one run at a time per slot.
//
// The worker process runs as root only so that it can start children as runner1..runner8
// (uid/gid 2001..2008). Each child gets:
//   - its own process group (detached), so the whole group can be killed;
//   - prlimit limits on processes, file size, open files and CPU time;
//   - an environment of only PATH, HOME and TMPDIR (plus GOMEMLIMIT for Go);
//   - a fresh working directory that only that runner can use (mode 700);
//   - a wall-clock timer and a memory watcher that kill the group.
import { spawn } from 'node:child_process';
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MB = 1024 * 1024;

/** Where per-run directories are made. Runners cannot write here, only into their own run directory. */
export const WORK_ROOT = process.env.WORKER_WORK_ROOT ?? '/work';

export const SLOT_COUNT = 8;
/** Slot n runs as uid and gid UID_BASE + n (runner1 = 2001 ... runner8 = 2008). */
export const UID_BASE = 2000;

export const DEFAULT_MAX_OUTPUT_BYTES = MB; // docs/DESIGN.md: output captured up to 1 MB
export const MAX_STDERR_BYTES = 64 * 1024;
export const POLL_INTERVAL_MS = 10;

const PRLIMIT = '/usr/bin/prlimit';
const SAFE_PATH = '/usr/local/go/bin:/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin';

export function slotIds(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new Error(`Slot must be an integer from 1 to ${SLOT_COUNT}, got ${String(slot)}`);
  }
  return { uid: UID_BASE + slot, gid: UID_BASE + slot };
}

function requireRoot() {
  if (process.getuid?.() !== 0) {
    throw new Error('The sandbox must run as root so it can start children as a runner user');
  }
}

/** A new empty directory only the slot's runner can use. `files` are written into it first. */
export async function createRunDir(slot, files = {}) {
  requireRoot();
  const { uid, gid } = slotIds(slot);
  const dir = await mkdtemp(join(WORK_ROOT, `run-${slot}-`));
  await chown(dir, uid, gid);
  await chmod(dir, 0o700);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await writeFile(path, content, { mode: 0o600 });
    await chown(path, uid, gid);
  }
  return dir;
}

export async function removeRunDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

/** Names of the files in `dir` for which `accept(name)` is true. */
export async function listFiles(dir, accept) {
  return (await readdir(dir)).filter(accept);
}

/** Copies the named files from one run directory into another, keeping them runnable and owned by the runner. */
export async function copyFiles(slot, fromDir, toDir, names) {
  const { uid, gid } = slotIds(slot);
  for (const name of names) {
    const target = join(toDir, name);
    await copyFile(join(fromDir, name), target);
    await chmod(target, 0o700);
    await chown(target, uid, gid);
  }
}

export async function readFileAsRoot(path) {
  return readFile(path);
}

/** Resident memory (MB) of every live process in a process group, summed. */
function groupMemoryMb(pgid) {
  let rssKb = 0;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // "pid (comm) S ppid pgrp ..."; comm can contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || Number(fields[2]) !== pgid) continue;
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${name}/status`, 'utf8'));
      if (rss) rssKb += Number(rss[1]);
    } catch {
      // the process exited while we were looking
    }
  }
  return rssKb / 1024;
}

/** Pids of live (not zombie) processes whose real uid is `uid`. */
export function processesOfUid(uid) {
  const pids = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const state = /^State:\s+(\S)/m.exec(status)?.[1];
      const real = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      if (state !== 'Z' && Number(real) === uid) pids.push(Number(name));
    } catch {
      // gone
    }
  }
  return pids;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function streamDone(stream) {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.readableEnded) return resolve();
    stream.once('close', resolve);
    stream.once('end', resolve);
    return undefined;
  });
}

/**
 * Kills every process of the slot's runner, wherever it is (a program that calls setsid() leaves
 * its process group). Returns how many it had to kill.
 */
export async function killSlotProcesses(slot) {
  const { uid } = slotIds(slot);
  let killed = 0;
  for (let round = 0; round < 50; round += 1) {
    const pids = processesOfUid(uid);
    if (pids.length === 0) return killed;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // already gone
      }
    }
    await sleep(5);
  }
  throw new Error(`Could not clear the processes of runner${slot}`);
}

/**
 * Runs one command in `dir` as the slot's runner.
 *
 * Returns { exitCode, signal, stdout, stderr, killedBy, outputTruncated, elapsedMs, peakRssMb }
 * where killedBy is null, 'timeout', 'memory' or 'output' (the first limit that fired).
 */
export function runSandboxed({
  slot,
  dir,
  command,
  args = [],
  stdin = '',
  timeoutMs,
  memoryLimitMb,
  limits,
  extraEnv = {},
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
}) {
  requireRoot();
  const { uid, gid } = slotIds(slot);

  const prlimitArgs = [
    `--nproc=${limits.nproc}`,
    `--fsize=${limits.fsizeMb * MB}`,
    `--nofile=${limits.nofile}`,
    // Soft limit first: at the soft limit the kernel sends SIGXCPU, which is how a CPU hog is
    // told apart from other kills. The hard limit one second later is SIGKILL.
    `--cpu=${limits.cpuSeconds}:${limits.cpuSeconds + 1}`,
    '--core=0',
    '--',
    command,
    ...args,
  ];
  const env = { PATH: SAFE_PATH, HOME: dir, TMPDIR: dir, ...extraEnv };

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(PRLIMIT, prlimitArgs, {
      uid,
      gid,
      cwd: dir,
      env,
      detached: true, // its own process group (pgid = pid)
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let killedBy = null;
    let peakRssMb = 0;
    let outputTruncated = false;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const killGroup = (reason) => {
      killedBy ??= reason;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the group is already gone
      }
    };

    const wallTimer = setTimeout(() => killGroup('timeout'), timeoutMs);
    const poller = setInterval(() => {
      if (child.pid === undefined) return;
      const rss = groupMemoryMb(child.pid);
      if (rss > peakRssMb) peakRssMb = rss;
      if (rss > memoryLimitMb) killGroup('memory');
    }, POLL_INTERVAL_MS);

    child.stdout.on('data', (chunk) => {
      if (outputTruncated) return;
      const room = maxOutputBytes - stdoutBytes;
      if (chunk.length > room) {
        stdout.push(chunk.subarray(0, Math.max(room, 0)));
        stdoutBytes = maxOutputBytes;
        outputTruncated = true;
        killGroup('output');
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      const room = maxStderrBytes - stderrBytes;
      if (room <= 0) return;
      stderr.push(chunk.subarray(0, room));
      stderrBytes += Math.min(chunk.length, room);
    });

    child.stdin.on('error', () => {
      // the program exited without reading all of its input
    });
    child.stdin.end(stdin);

    child.on('error', (error) => {
      clearTimeout(wallTimer);
      clearInterval(poller);
      reject(error);
    });

    // 'exit', not 'close': a program can leave a background process holding its output pipe open,
    // and 'close' would then wait for it. We clear everything the runner left, then drain the pipes.
    child.on('exit', async (exitCode, signal) => {
      clearTimeout(wallTimer);
      clearInterval(poller);
      try {
        killGroup(null);
        await killSlotProcesses(slot);
        await Promise.race([
          Promise.all([streamDone(child.stdout), streamDone(child.stderr)]),
          sleep(1000),
        ]);
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          killedBy,
          outputTruncated,
          elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          peakRssMb,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** The real sandbox, in the shape judge.js and setup.js expect (tests pass a fake with the same shape). */
export const sandbox = {
  createRunDir,
  removeRunDir,
  listFiles,
  copyFiles,
  runSandboxed,
};

/**
 * Makes sure the work root exists, is owned by root and is mode 755 (so a runner can write only
 * into the directory made for its own run), and removes run directories left by an earlier
 * process. An ephemeral volume may start out with other permissions.
 */
export async function prepareWorkRoot() {
  requireRoot();
  await mkdir(WORK_ROOT, { recursive: true });
  await chown(WORK_ROOT, 0, 0);
  await chmod(WORK_ROOT, 0o755);
  for (const name of await readdir(WORK_ROOT)) {
    if (name.startsWith('run-')) await rm(join(WORK_ROOT, name), { recursive: true, force: true });
  }
}
