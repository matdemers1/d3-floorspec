// A thread that says it has started, then holds its own event loop for good: only ending it stops it.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'started' });
for (;;) Math.sqrt(Math.random());
