import { defineConfig } from 'tsup';

const shared = {
  outDir: 'dist',
  format: ['esm'] as const,
  sourcemap: true,
  clean: false,
  target: 'es2022',
};

export default defineConfig([
  {
    ...shared,
    entry: { 'sdk/lib': 'sdk/lib.ts' },
    dts: true,
    clean: true,
    platform: 'browser',
    splitting: true,
    external: ['#scanner-loader', 'viem'],
  },
  {
    ...shared,
    entry: { 'src/worker-loader.browser': 'src/worker-loader.browser.ts' },
    dts: true,
    platform: 'browser',
    external: ['comlink'],
  },
  {
    ...shared,
    entry: { 'src/worker-loader.node': 'src/worker-loader.node.ts' },
    dts: true,
    platform: 'node',
    external: ['comlink', 'worker_threads'],
  },
  {
    ...shared,
    entry: { 'src/scanner.worker': 'src/scanner.worker.ts' },
    dts: false,
    platform: 'browser',
    splitting: false,
    noExternal: [/.*/],
  },
  {
    ...shared,
    entry: { 'src/scanner.worker.node': 'src/scanner.worker.node.ts' },
    dts: false,
    platform: 'node',
    splitting: false,
    noExternal: [/^(?!(worker_threads)$)/],
    external: ['worker_threads'],
  }
]);
