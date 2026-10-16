import { fileURLToPath } from 'node:url';

/** Absolute path of a source file under the repo's services folder. */
export function serviceEntry(relativePath: string): string {
  return fileURLToPath(new URL(`../../../services/${relativePath}`, import.meta.url));
}

export const REPO_LOCK_FILE = fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url));
