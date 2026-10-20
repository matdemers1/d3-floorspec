/**
 * A film drawn on a thread of its own (FLR-T-14.10): the frames of frames.ts, each handed to the
 * main thread — which feeds ffmpeg and reports progress — and the next drawn when it says so. The
 * main thread stays free to answer while a frame is drawn, and stops a cancelled film by ending the
 * thread, mid-frame. It speaks through the shared thread helper (threads/, FLR-T-14.12).
 */
import type { MessagePort } from 'node:worker_threads';
import { assetDirImages } from '../export/gltf/assets.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { serve } from '../threads/serve.js';
import { planFilm, renderFrames, type FilmChoice } from './frames.js';

export interface FilmThreadData {
  readonly document: object;
  readonly choice: FilmChoice;
  /** The asset store and the digests the job's project claimed: the only maps a film may draw. */
  readonly assets?: { readonly dir: string; readonly claimed?: readonly string[] };
}

function imagesOf(assets: FilmThreadData['assets']): ImageSource | undefined {
  const source = assetDirImages(assets?.dir);
  if (source === undefined || assets?.claimed === undefined) return source;
  const claimed = new Set(assets.claimed);
  return (asset) => (claimed.has(asset.sha256) ? source(asset) : undefined);
}

/** Each frame handed over, and the next drawn when the main thread says it has taken it. */
async function draw(raw: unknown, port: MessagePort): Promise<Record<string, string> | null> {
  const data = raw as FilmThreadData;
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
  const { design } = await renderFrames(data.document, data.choice, planFilm(data.document, data.choice), (rgb, progress) => {
    const next = new Promise<void>((resolve) => { taken = resolve; });
    // The pixels moved, not copied.
    const bytes = rgb.byteOffset === 0 && rgb.byteLength === rgb.buffer.byteLength ? rgb : rgb.slice();
    port.postMessage({ type: 'frame', rgb: bytes, progress }, [bytes.buffer as ArrayBuffer]);
    return next;
  }, images === undefined ? {} : { images });
  return design;
}

serve(draw);
