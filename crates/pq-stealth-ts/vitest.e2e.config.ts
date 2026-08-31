import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/anvil-e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
