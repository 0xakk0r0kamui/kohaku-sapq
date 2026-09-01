import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'sdk/index': 'sdk/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: true,
  external: [
    '../pkg/index.js',
    '@kohaku-eth/plugins',
    '@kohaku-eth/provider',
    'viem',
  ],
});
