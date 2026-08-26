import { wrap } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import { Worker } from 'worker_threads';
import type { ScannerWorkerApi } from './scanner-api.js';

export function loadScannerWorker(workerUrl?: string | URL) {
  if (workerUrl !== undefined) {
    console.warn('[pq-stealth] workerUrl is ignored in Node; the packaged worker is used.');
  }
  const worker = new Worker(new URL('./scanner.worker.node.js', import.meta.url));
  return {
    remote: wrap<ScannerWorkerApi>(nodeEndpoint(worker)),
    close: async () => { await worker.terminate(); },
  };
}
