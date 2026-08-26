import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/anvil-e2e.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 240_000,
    fileParallelism: false,
  },
});
