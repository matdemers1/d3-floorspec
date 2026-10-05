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
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
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
export const canThread = (): boolean => existsSync(fileURLToPath(THREAD));

export async function traceParallel(scene: PtScene, options: TraceOptions, threads = stillThreads()): Promise<{ color: Float32Array; features: Features; threads: number }> {
  const n = Math.min(threads, options.height);
  if (n <= 1 || !canThread()) return { ...(await trace(scene, options)), threads: 1 };
  const { onPass, ...rest } = options;
  const done = new Array<number>(n).fill(0);
  let reported = 0;
  const workers: Worker[] = [];
  try {
    const shares = await Promise.all(
      Array.from({ length: n }, (_, index) => {
        const worker = new Worker(THREAD, { workerData: { scene, options: { ...rest, rows: { of: n, index } } } });
        workers.push(worker);
        return new Promise<{ color: Float32Array; features: Features }>((resolve, reject) => {
          worker.on('message', (m: { type: 'pass'; done: number } | { type: 'done'; color: Float32Array; features: Features } | { type: 'error'; message: string }) => {
            if (m.type === 'pass') {
              done[index] = m.done;
              const least = Math.min(...done);
              if (least > reported) {
                reported = least;
                void onPass?.(least, options.samples);
              }
            } else if (m.type === 'done') resolve({ color: m.color, features: m.features });
            else reject(new Error(m.message));
          });
          worker.on('error', reject);
          worker.on('exit', (code) => { if (code !== 0) reject(new Error(`a still thread stopped (${String(code)})`)); });
        });
      }),
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
    for (const w of workers) void w.terminate();
  }
}
