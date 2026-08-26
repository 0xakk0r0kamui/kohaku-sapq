/// <reference lib="webworker" />
import { expose } from 'comlink';
import { scannerWorkerApi } from './scanner-api.js';

expose(scannerWorkerApi);
