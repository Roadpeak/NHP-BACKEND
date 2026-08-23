import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The refusal tests share a database; running them in parallel would
    // let one test's cleanup delete another's fixtures.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
