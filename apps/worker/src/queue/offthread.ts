/**
 * A job run on a thread of its own (FLR-T-14.12, FLR-ADR-059). The process that drains the queue — the worker,
 * or the api in development and the tests — only orchestrates: it starts the thread with the
 * job's document and parameters, writes the progress the thread reports, reads another version
 * when the thread asks for one, and stores the file the thread hands back. Meshing, tracing,
 * rasterizing and encoding happen on the thread, so the process keeps answering while a tour is
 * path-traced; and a job cancelled mid-way is stopped at once, its thread ended, wherever it is.
 *
 * The thread runs the same handler the process would have run (`createHandlers({ inline: true })`),
 * so a job's file is byte for byte what it was in-process.
 */
import type { MessagePort } from 'node:worker_threads';
import { canThread, describeError, revive, runThread, transferable, type ThreadError } from '../threads/index.js';
import type { Handler, JobFile, JobRow } from './handlers.js';

const JOB_THREAD = new URL('./thread.js', import.meta.url);

/** Whether the compiled job thread exists to start (it does not when running from sources). */
export const canJobThread = (): boolean => canThread(JOB_THREAD);

/** What a job's thread is given: everything about the job a function is not. */
export interface JobThreadData {
  readonly document: object;
  readonly job: Pick<JobRow, 'id' | 'projectId' | 'kind' | 'params' | 'versionHash'>;
  /** The digests the job's project claimed, when the drain said. */
  readonly claimed?: readonly string[];
  /** Whether the thread may ask for another version's document. */
  readonly load: boolean;
  readonly assetDir?: string;
}

/** What a job's thread asks of the main thread, and the main thread's answers. */
export type JobThreadAsk = { readonly type: 'progress'; readonly progress: Record<string, unknown> } | { readonly type: 'load'; readonly id: number; readonly hash: string };
export type JobThreadAnswer = { readonly type: 'loaded'; readonly id: number; readonly document?: object; readonly error?: ThreadError };

/** The thread's data for `job`. */
export function jobThreadData(document: object, job: JobRow, assetDir?: string): JobThreadData {
  return {
    document,
    job: { id: job.id, projectId: job.projectId, kind: job.kind, params: job.params, versionHash: job.versionHash },
    ...(job.claimed === undefined ? {} : { claimed: [...job.claimed] }),
    load: job.load !== undefined,
    ...(assetDir === undefined ? {} : { assetDir }),
  };
}

/**
 * The main thread's answer to what a job's thread asks: progress written (a job no longer this
 * worker's throws, which ends the thread), another version read.
 */
export function answerJobThread(job: JobRow): (message: unknown, post: (answer: JobThreadAnswer) => void) => Promise<void> {
  return async (message, post) => {
    const m = message as JobThreadAsk | { type?: undefined };
    if (m.type === 'progress') {
      await job.progress?.(m.progress);
    } else if (m.type === 'load') {
      try {
        if (job.load === undefined) throw new Error('this worker cannot read another version');
        post({ type: 'loaded', id: m.id, document: await job.load(m.hash) });
      } catch (error) {
        post({ type: 'loaded', id: m.id, error: describeError(error) });
      }
    }
  };
}

/** Run `job` on its own thread; its signal ends the thread at once. */
export function onJobThread(document: object, job: JobRow, assetDir?: string): Promise<JobFile> {
  return runThread<JobFile>(JOB_THREAD, jobThreadData(document, job, assetDir), {
    name: `the ${job.kind} job's thread`,
    ...(job.signal === undefined ? {} : { signal: job.signal }),
    stopped: () => new Error(`the ${job.kind} job was stopped`),
    onMessage: answerJobThread(job),
  });
}

/** A file's buffers, to move rather than copy back to the main thread. */
export const jobFileBuffers = (file: JobFile): ArrayBuffer[] => transferable([file.bytes, ...(file.assets ?? []).map((a) => a.bytes)]);

/**
 * The thread's side: run the job's handler from `table` as the process would have, its progress and
 * its reads of other versions going over `port` to the main thread.
 */
export async function threadJob(data: JobThreadData, port: MessagePort, table: Readonly<Record<string, Handler>>): Promise<JobFile> {
  const handler = table[data.job.kind];
  if (handler === undefined) throw new Error(`no worker knows how to run a ${data.job.kind} job`);
  let asked = 0;
  const waiting = new Map<number, { resolve: (document: object) => void; reject: (error: Error) => void }>();
  const listen = (raw: unknown) => {
    const m = raw as JobThreadAnswer | { type?: undefined };
    if (m.type !== 'loaded') return;
    const w = waiting.get(m.id);
    if (w === undefined) return;
    waiting.delete(m.id);
    if (m.document === undefined) w.reject(revive(m.error ?? { name: 'Error', message: 'the version could not be read' }));
    else w.resolve(m.document);
  };
  port.on('message', listen);
  const ask = (m: JobThreadAsk) => { port.postMessage(m); };
  const job: JobRow = {
    ...data.job,
    ...(data.claimed === undefined ? {} : { claimed: new Set(data.claimed) }),
    // Said, not awaited: the main thread writes it at most once a second, and stops the thread if the job is no longer its.
    progress: (progress) => {
      ask({ type: 'progress', progress });
      return Promise.resolve();
    },
    ...(data.load
      ? {
          load: (hash: string) =>
            new Promise<object>((resolve, reject) => {
              const id = ++asked;
              waiting.set(id, { resolve, reject });
              ask({ type: 'load', id, hash });
            }),
        }
      : {}),
  };
  try {
    return await handler(data.document, job);
  } finally {
    port.off('message', listen);
  }
}
