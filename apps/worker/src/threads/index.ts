/**
 * Work on a thread of its own (FLR-T-14.12), the pattern films started (FLR-T-14.10) made one helper:
 * the main thread starts the thread, answers what it asks for — the next frame, another version's
 * document, a job's progress — and takes its result; the thread does the heavy part — meshing,
 * tracing, encoding — so the process that holds the job keeps answering. The api drains the queue
 * inline in development and the tests: a tour meshed on its own event loop held the next request
 * for ten seconds.
 *
 * A signal ends the thread at once, wherever it is (and the threads it started with it), and the
 * call rejects with `stopped()`. The thread speaks through `serve` (serve.ts): `done` with the
 * result, `error` with what went wrong; anything else it posts is the caller's `onMessage`, which
 * may answer through `post`. If `onMessage` throws, the thread is ended and the call rejects with
 * that error.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, type Transferable } from 'node:worker_threads';
import { revive, type ThreadError } from './errors.js';

export { describeError, revive, transferable, type ThreadError } from './errors.js';

/** What the thread's `serve` posts at the end. */
export type ThreadEnd<R> = { readonly type: 'done'; readonly value: R } | { readonly type: 'error'; readonly error: ThreadError };

export interface ThreadOptions {
  /** Ends the thread at once and rejects with `stopped()`. */
  readonly signal?: AbortSignal;
  /** The error a stopped call rejects with. Default the signal's reason when it is an Error, else "the thread was stopped". */
  readonly stopped?: () => Error;
  /** Anything the thread posts other than its end. Answer through `post`; throwing ends the thread. */
  readonly onMessage?: (message: unknown, post: (message: unknown, transfer?: readonly Transferable[]) => void) => void | Promise<void>;
  /** What the thread is called in an error message. Default "a worker thread". */
  readonly name?: string;
}

/** Whether a compiled thread exists to start: it does not when running from TypeScript sources (the unit tests). */
export const canThread = (url: URL): boolean => existsSync(fileURLToPath(url));

const isEnd = (m: unknown): m is ThreadEnd<unknown> =>
  typeof m === 'object' && m !== null && ((m as { type?: unknown }).type === 'done' || (m as { type?: unknown }).type === 'error');

/** Run the thread at `url` with `workerData` until it posts its end. */
export function runThread<R>(url: URL, workerData: unknown, options: ThreadOptions = {}): Promise<R> {
  const { signal, onMessage } = options;
  const name = options.name ?? 'a worker thread';
  const stopped = options.stopped ?? (() => (signal?.reason instanceof Error ? signal.reason : new Error(`${name} was stopped`)));
  if (signal?.aborted === true) return Promise.reject(stopped());
  return new Promise<R>((resolve, reject) => {
    const worker = new Worker(url, { workerData });
    let settled = false;
    const end = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      void worker.terminate();
      fn();
    };
    const fail = (error: unknown) => { end(() => { reject(error instanceof Error ? error : new Error(String(error))); }); };
    const stop = () => { end(() => { reject(stopped()); }); };
    signal?.addEventListener('abort', stop, { once: true });
    const post = (message: unknown, transfer?: readonly Transferable[]) => {
      if (!settled) worker.postMessage(message, transfer);
    };
    worker.on('message', (m: unknown) => {
      if (settled) return;
      if (isEnd(m)) {
        if (m.type === 'done') end(() => { resolve(m.value as R); });
        else end(() => { reject(revive(m.error)); });
        return;
      }
      if (onMessage === undefined) return;
      try {
        const answered = onMessage(m, post);
        if (answered instanceof Promise) answered.catch(fail);
      } catch (error) {
        fail(error);
      }
    });
    worker.on('error', fail);
    worker.on('exit', (code) => { fail(new Error(`${name} stopped (${String(code)}) before it finished`)); });
  });
}
