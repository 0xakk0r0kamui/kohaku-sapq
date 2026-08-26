import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import { parentPort } from 'worker_threads';
import { scannerWorkerApi } from './scanner-api.js';

if (!parentPort) throw new Error('scanner.worker.node must run in a worker thread');
expose(scannerWorkerApi, nodeEndpoint(parentPort));
