/**
 * One thread's share of a still (threads.ts): every `of`-th row of every pass. It reports each pass
 * and hands back what it traced; the main thread adds the shares up.
 */
import { serve } from '../threads/serve.js';
import { trace, type PtScene, type TraceOptions } from './trace.js';

interface Job {
  readonly scene: PtScene;
  readonly options: Omit<TraceOptions, 'onPass'>;
}

serve(
  (raw, port) => {
    const job = raw as Job;
    return trace(job.scene, { ...job.options, onPass: (done) => { port.postMessage({ type: 'pass', done }); } });
  },
  ({ color, features }) => [color.buffer, features.albedo.buffer, features.normal.buffer, features.depth.buffer, features.variance.buffer] as ArrayBuffer[],
);
