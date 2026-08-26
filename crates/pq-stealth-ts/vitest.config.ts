import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['tests/anvil-e2e.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
