/**
 * The thread's side of `runThread` (index.ts, FLR-T-14.12): run `work` on the thread's data, then
 * post its end — `done` with the result, its buffers moved where they can be, or `error` with what
 * went wrong. `work` talks to the main thread on the port it is given for anything in between.
 */
import { parentPort, workerData, type MessagePort, type Transferable } from 'node:worker_threads';
import { describeError } from './errors.js';

export function serve<R>(work: (data: unknown, port: MessagePort) => Promise<R>, transfer?: (result: R) => readonly Transferable[]): void {
  const port = parentPort;
  if (port === null) throw new Error('this module runs as a worker thread');
  void endWith(port, work(workerData, port), transfer);
}

/** Post `result`'s end on `port`. Exported for the tests, which run a thread's work on a MessageChannel. */
export async function endWith<R>(port: MessagePort, result: Promise<R>, transfer?: (result: R) => readonly Transferable[]): Promise<void> {
  let value: R;
  try {
    value = await result;
  } catch (error) {
    port.postMessage({ type: 'error', error: describeError(error) });
    return;
  }
  const moved = transfer?.(value) ?? [];
  try {
    port.postMessage({ type: 'done', value }, moved);
  } catch {
    // A buffer that may not be moved (one Node keeps for itself): copied instead.
    port.postMessage({ type: 'done', value });
  }
}
