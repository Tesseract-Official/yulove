import { defineConfig } from 'vitest/config';

// In the locked-down test container the root filesystem is read-only, so everything Vite and
// Vitest cache goes wherever VITEST_CACHE_DIR points (a writable volume).
const cacheDir = process.env.VITEST_CACHE_DIR;

export default defineConfig({
  cacheDir: cacheDir ?? 'node_modules/.vite',
  test: {
    ...(cacheDir ? { fsModuleCachePath: `${cacheDir}/modules` } : {}),
    // Sandbox tests compile Java and Go and wait for time limits.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The sandbox tests share the runner users, so test files run one at a time.
    fileParallelism: false,
  },
});
