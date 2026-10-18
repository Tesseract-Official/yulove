import { parseArgs, type ParseArgsConfig } from 'node:util';

/**
 * Command-line flags for a script. pnpm hands a script exactly what was typed after its name, so
 * `pnpm cleanup:dev-data --dry-run` gives it `--dry-run`. People who add the `--` that npm needs
 * (an extra `--` between the script name and the flag) would otherwise have `--dry-run` read as a
 * plain word and the flag silently ignored, which for a safety flag is dangerous. A lone `--` is dropped.
 */
export function parseFlags<T extends ParseArgsConfig['options']>(
  argv: readonly string[],
  options: T,
  allowPositionals = false,
) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  return parseArgs({ args, options, allowPositionals, strict: true });
}
