/**
 * A film drawn on a thread of its own (FLR-T-14.10): the frames of frames.ts, each handed to the
 * main thread — which feeds ffmpeg and reports progress — and the next drawn when it says so. The
 * main thread stays free to answer while a frame is drawn, and stops a cancelled film by ending the
 * thread, mid-frame.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { assetDirImages } from '../export/gltf/assets.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { planFilm, renderFrames, type FilmChoice } from './frames.js';

export interface FilmThreadData {
  readonly document: object;
  readonly choice: FilmChoice;
  /** The asset store and the digests the job's project claimed: the only maps a film may draw. */
  readonly assets?: { readonly dir: string; readonly claimed?: readonly string[] };
}

const data = workerData as FilmThreadData;
const port = parentPort;
if (port === null) throw new Error('the film thread runs as a worker thread');

function imagesOf(assets: FilmThreadData['assets']): ImageSource | undefined {
  const source = assetDirImages(assets?.dir);
  if (source === undefined || assets?.claimed === undefined) return source;
  const claimed = new Set(assets.claimed);
  return (asset) => (claimed.has(asset.sha256) ? source(asset) : undefined);
}

/** The main thread's word that the last frame is taken. */
let taken: (() => void) | null = null;
port.on('message', (m: { type?: unknown }) => {
  if (m.type === 'next') {
    const go = taken;
    taken = null;
    go?.();
  }
});

const images = imagesOf(data.assets);
renderFrames(data.document, data.choice, planFilm(data.document, data.choice), (rgb, progress) => {
  const next = new Promise<void>((resolve) => { taken = resolve; });
  // The pixels moved, not copied.
  const bytes = rgb.byteOffset === 0 && rgb.byteLength === rgb.buffer.byteLength ? rgb : rgb.slice();
  port.postMessage({ type: 'frame', rgb: bytes, progress }, [bytes.buffer as ArrayBuffer]);
  return next;
}, images === undefined ? {} : { images })
  .then(({ design }) => { port.postMessage({ type: 'done', design }); })
  .catch((error: unknown) => { port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error), range: error instanceof RangeError }); });
