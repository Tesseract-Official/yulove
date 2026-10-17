#!/usr/bin/env node
// Runs one judgement or one question setup locally and prints the result.
//
//   node cli.js fixtures/<case>.json
//
// A fixture is { "kind": "judge" | "setup", "job": { ... } }. "judge" runs a student answer
// (see src/judge.js for the fields), "setup" runs a question's generator and reference solution
// (see src/setup.js). Everything runs in the sandbox as runner1, so this needs root and the
// worker image's toolchains: run it with `docker run --rm <image> node cli.js fixtures/<case>.json`.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { judge } from './src/judge.js';
import { runSetup } from './src/setup.js';

const SLOT = 1;

export async function runFixture(fixture, deps = {}) {
  switch (fixture.kind) {
    case 'judge':
      return judge({ slot: SLOT, ...fixture.job }, deps);
    case 'setup':
      return runSetup({ slot: SLOT, ...fixture.job }, deps);
    default:
      throw new Error(`Unknown fixture kind "${String(fixture.kind)}": use "judge" or "setup"`);
  }
}

async function main(argv) {
  const [file] = argv;
  if (!file) {
    console.error('Usage: node cli.js fixtures/<case>.json');
    return 2;
  }
  const fixture = JSON.parse(await readFile(file, 'utf8'));
  const result = await runFixture(fixture);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
