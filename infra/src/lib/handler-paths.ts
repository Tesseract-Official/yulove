import { fileURLToPath } from 'node:url';

/** Absolute path of a source file under the repo's services folder. */
export function serviceEntry(relativePath: string): string {
  return fileURLToPath(new URL(`../../../services/${relativePath}`, import.meta.url));
}

export const REPO_LOCK_FILE = fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url));

/** The worker's folder: its Dockerfile and sources are the container image. */
export const WORKER_DIR = fileURLToPath(new URL('../../../worker', import.meta.url));

/** The web app's build output, uploaded by WebDeploy. */
export const WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));
