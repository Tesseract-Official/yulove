import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // cdk synth copies the worker's source (tests included) into cdk.out for its Docker image.
    exclude: [...configDefaults.exclude, 'cdk.out/**'],
  },
});
