// A thread whose work fails with a refusal (a RangeError) and one that exits without a word.
import { parentPort, workerData } from 'node:worker_threads';

if (workerData.exit) process.exit(3);
parentPort.postMessage({ type: 'error', error: { name: 'RangeError', message: 'a still at that size is more work than a still may take' } });
