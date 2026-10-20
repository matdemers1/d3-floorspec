/**
 * A still traced on several threads (FLR-T-12.6): the rows dealt out in turn — row y to thread
 * y mod n, so every thread gets a share of the sky and of the house — each thread tracing its rows
 * for every pass, and their shares added up. Each pixel draws from its own seeded stream, so the
 * image is the same whatever the number of threads, one included.
 *
 * Threads come from `STILL_THREADS`, else one fewer than the machine's processors (the api and the
 * database live on the same box), at most four. Run from TypeScript sources (the tests), where there
 * is no compiled thread to start, a still is traced in-process.
 */
import { availableParallelism } from 'node:os';
import { canThread as compiled, runThread } from '../threads/index.js';
import type { Features } from './denoise.js';
import { trace, type PtScene, type TraceOptions } from './trace.js';

const THREAD = new URL('./thread.js', import.meta.url);

/** How many threads a still is traced on here. */
export function stillThreads(): number {
  const asked = Number.parseInt(process.env['STILL_THREADS'] ?? '', 10);
  if (Number.isInteger(asked) && asked >= 1) return Math.min(16, asked);
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** Whether the compiled thread exists to start (it does not when running from sources). */
export const canThread = (): boolean => compiled(THREAD);

/**
 * Trace on `threads` threads. With a `signal` (FLR-T-14.2: a tour's panorama, cancelled by a person),
 * aborting it ends the threads at once, mid-pass, and rejects with the signal's reason.
 */
export async function traceParallel(scene: PtScene, options: TraceOptions, threads = stillThreads(), signal?: AbortSignal): Promise<{ color: Float32Array; features: Features; threads: number }> {
  signal?.throwIfAborted();
  const n = Math.min(threads, options.height);
  if (n <= 1 || !canThread()) {
    // In-process (from sources): the passes yield, and a pass after the abort stops it.
    const onPass = options.onPass;
    const watched: TraceOptions = signal === undefined ? options : { ...options, onPass: async (done, total) => { signal.throwIfAborted(); await onPass?.(done, total); } };
    return { ...(await trace(scene, watched)), threads: 1 };
  }
  const { onPass, ...rest } = options;
  const done = new Array<number>(n).fill(0);
  let reported = 0;
  // Every thread ended together: by the signal, or when one fails, or when all are done.
  const all = new AbortController();
  const onAbort = () => { all.abort(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const stopped = () => (signal?.reason instanceof Error ? signal.reason : new Error('the trace was stopped'));
  try {
    const shares = await Promise.all(
      Array.from({ length: n }, (_, index) =>
        runThread<{ color: Float32Array; features: Features }>(THREAD, { scene, options: { ...rest, rows: { of: n, index } } }, {
          name: 'a still thread',
          signal: all.signal,
          stopped,
          onMessage: (message) => {
            const m = message as { type?: unknown; done?: unknown };
            if (m.type !== 'pass' || typeof m.done !== 'number') return;
            done[index] = m.done;
            const least = Math.min(...done);
            if (least > reported) {
              reported = least;
              void onPass?.(least, options.samples);
            }
          },
        }),
      ),
    );
    // Each pixel from the thread that traced it: row y belongs to thread y mod n.
    const out = shares[0]!;
    const W = options.width;
    for (let p = 0; p < W * options.height; p++) {
      const owner = Math.floor(p / W) % n;
      if (owner === 0) continue;
      const s = shares[owner]!;
      for (let c = 0; c < 3; c++) {
        out.color[3 * p + c] = s.color[3 * p + c]!;
        out.features.albedo[3 * p + c] = s.features.albedo[3 * p + c]!;
        out.features.normal[3 * p + c] = s.features.normal[3 * p + c]!;
      }
      out.features.depth[p] = s.features.depth[p]!;
      out.features.variance[p] = s.features.variance[p]!;
    }
    return { ...out, threads: n };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    all.abort();
  }
}
