import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/plugin.test.ts'],
    testTimeout: 30_000,
    disableConsoleIntercept: true,
  },
});
