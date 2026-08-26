import { wrap } from 'comlink';
import type { ScannerWorkerApi } from './scanner-api.js';

export function loadScannerWorker(workerUrl?: string | URL) {
  const worker = new Worker(workerUrl ?? new URL('./scanner.worker.js', import.meta.url), {
    type: 'module',
  });
  return {
    remote: wrap<ScannerWorkerApi>(worker),
    close: async () => { worker.terminate(); },
  };
}
