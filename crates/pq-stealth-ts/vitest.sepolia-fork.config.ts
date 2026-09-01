import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/sepolia-fork-e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
