/**
 * A job's thread (FLR-T-14.12, offthread.ts): the job's handler, run here exactly as the process
 * would have run it, its file handed back to the main thread to store.
 */
import { serve } from '../threads/serve.js';
import { createHandlers } from './handlers.js';
import { jobFileBuffers, threadJob, type JobThreadData } from './offthread.js';

serve(
  (raw, port) => {
    const data = raw as JobThreadData;
    return threadJob(data, port, createHandlers({ inline: true, ...(data.assetDir === undefined ? {} : { assetDir: data.assetDir }) }));
  },
  jobFileBuffers,
);
