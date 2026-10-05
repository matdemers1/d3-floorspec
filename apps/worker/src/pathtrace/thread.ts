/**
 * One thread's share of a still (threads.ts): every `of`-th row of every pass. It reports each pass
 * and hands back what it traced; the main thread adds the shares up.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { trace, type PtScene, type TraceOptions } from './trace.js';

interface Job {
  readonly scene: PtScene;
  readonly options: Omit<TraceOptions, 'onPass'>;
}

const job = workerData as Job;
const port = parentPort;
if (port === null) throw new Error('the still thread runs as a worker thread');

trace(job.scene, { ...job.options, onPass: (done) => { port.postMessage({ type: 'pass', done }); } })
  .then(({ color, features }) => {
    port.postMessage({ type: 'done', color, features }, [color.buffer, features.albedo.buffer, features.normal.buffer, features.depth.buffer, features.variance.buffer] as ArrayBuffer[]);
  })
  .catch((error: unknown) => {
    port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
