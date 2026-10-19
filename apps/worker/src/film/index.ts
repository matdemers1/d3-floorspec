/**
 * Films (FLR-T-14.1): a document's camera path (@floorspec/mesh `filmsOf`, kept in its extras —
 * FLR-ADR-051) rendered frame by frame and encoded as a video. A draft is drawn by the worker's
 * rasterizer (render3d/raster.ts), its lamps lighting their own rooms; a final is path-traced, each
 * frame a still (pathtrace/index.ts `renderSceneStill`) through the same camera a saved view's still
 * looks through (`viewCamera`), denoised. The frames go to ffmpeg as they are made (encode.ts).
 *
 * The doors are open — a film goes through them. Light: as the film's first saved view has it — its sky, its time, its lights — fixed for the whole
 * film; or day to night, the timelapse (@floorspec/mesh/sky `timelapseSchedule`): the sun at each
 * frame's instant at the site under the clear sky, which follows it through sunset into night, and
 * the lights fading up after sunset.
 *
 * Exposure follows the frames as a camera's does, never jumping: each frame's own — the sky's
 * outside, metered within its band inside a room (as a still is) — eased towards over half a second
 * of film, in stops. So the band change at sunset, or a cut from the lawn into a room, is a short
 * adjustment rather than a flash.
 *
 * Drawing runs on a thread of its own (thread.ts, FLR-T-14.10): the process holding the job keeps
 * answering — the api drains inline in development and the tests — and a cancelled film is stopped
 * at once, mid-frame, its ffmpeg killed and nothing kept.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Timelapse } from '@floorspec/mesh/sky';
import type { ImageSource } from '../export/gltf/glb.js';
import { describeVideo, startEncoder, type Encoder, type VideoFacts } from './encode.js';
import { planFilm, renderFrames, type FilmChoice, type FilmProgress } from './frames.js';
import { FILM_CONTENT_TYPES, MAX_FILM_BYTES, type FilmFormat, type FilmLight, type FilmQuality } from './presets.js';

export * from './presets.js';
export { describeVideo, ffmpegReady, startEncoder, type Encoder, type VideoFacts } from './encode.js';
export { Adaptation, planFilm, renderFrames, type FilmChoice, type FilmPlan, type FilmProgress } from './frames.js';

/** A film stopped by its signal: cancelled, or no longer this worker's. */
export class FilmStopped extends Error {
  constructor() {
    super('the film was stopped');
    this.name = 'FilmStopped';
  }
}

const THREAD = new URL('./thread.js', import.meta.url);
/** Whether the compiled film thread exists to start (it does not when running from sources). */
export const canFilmThread = (): boolean => existsSync(fileURLToPath(THREAD));

export interface FilmOptions extends FilmChoice {
  /** The maps, in-process; a thread reads them from `assets` instead (a function cannot be handed to one). */
  readonly images?: ImageSource;
  readonly assets?: { readonly dir: string; readonly claimed?: readonly string[] };
  /** After each frame: how far it has got. Throwing stops the film. */
  readonly onFrame?: (progress: FilmProgress) => void | Promise<void>;
  /** Stops the film at once — mid-frame on a thread — with a `FilmStopped`, keeping nothing. */
  readonly signal?: AbortSignal;
  /** Draw in this process even where the compiled thread exists (tests). */
  readonly inProcess?: boolean;
}


export interface FilmResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly film: { readonly id: string; readonly name: string };
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly seconds: number;
  readonly format: FilmFormat;
  readonly quality: FilmQuality;
  /** A final's samples a pixel. */
  readonly samples?: number;
  readonly light: FilmLight;
  /** Day to night: the day, its clocks and its sunset at the site. */
  readonly timelapse?: Timelapse & { readonly sunset: string | null };
  readonly video: VideoFacts | null;
  readonly design: Record<string, string> | null;
  readonly ms: number;
}


/** Render a film to a video. Throws a RangeError for a film the document does not have, or cannot be rendered as asked. */
export async function renderFilm(document: object, options: FilmOptions): Promise<FilmResult> {
  const started = Date.now();
  // Checked here, before ffmpeg or a thread is started: a refusal is a RangeError the job reports.
  const plan = planFilm(document, options);
  const { film, frames, width, height, samples, timelapse, schedule } = plan;
  const signal = options.signal;
  // Read through a function: the signal changes while frames are awaited.
  const aborted = (): boolean => signal?.aborted === true;
  if (aborted()) throw new FilmStopped();
  const encoder = await startEncoder({ width, height, fps: options.fps, format: options.format, quality: options.quality, title: film.name });
  const choice: FilmChoice = {
    film: options.film,
    quality: options.quality,
    format: options.format,
    size: options.size,
    fps: options.fps,
    light: options.light,
    ...(options.timelapse === undefined ? {} : { timelapse: options.timelapse }),
    ...(options.design === undefined ? {} : { design: options.design }),
    ...(options.pixels === undefined ? {} : { pixels: options.pixels }),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  };
  /** One frame taken: into ffmpeg, then reported. */
  const take = async (rgb: Uint8Array, progress: FilmProgress): Promise<void> => {
    if (aborted()) throw new FilmStopped();
    await encoder.write(rgb);
    await options.onFrame?.(progress);
  };
  let design: Record<string, string> | null;
  try {
    design = options.inProcess !== true && canFilmThread() ? await onThread(document, choice, options.assets, take, signal) : await inProcess(document, choice, plan, options.images, take, signal);
  } catch (error) {
    await encoder.abort();
    throw aborted() ? new FilmStopped() : error;
  }
  if (aborted()) {
    await encoder.abort();
    throw new FilmStopped();
  }
  const bytes = await finished(encoder);
  if (bytes.byteLength > MAX_FILM_BYTES) throw new RangeError(`the film came to ${String(Math.round(bytes.byteLength / 1048576))} MB, more than the ${String(MAX_FILM_BYTES / 1048576)} MB a film may be: choose a smaller size, a lower frame rate or a shorter film`);
  return {
    bytes,
    contentType: FILM_CONTENT_TYPES[options.format],
    film: { id: film.id, name: film.name },
    width,
    height,
    fps: options.fps,
    frames,
    seconds: frames / options.fps,
    format: options.format,
    quality: options.quality,
    ...(samples === undefined ? {} : { samples }),
    light: options.light,
    ...(timelapse === undefined || schedule === undefined ? {} : { timelapse: { ...timelapse, sunset: schedule.sunset === null ? null : schedule.clockOf(schedule.sunset) } }),
    video: describeVideo(bytes),
    design,
    ms: Date.now() - started,
  };
}

const finished = (encoder: Encoder): Promise<Uint8Array> => encoder.finish();

/** Draw in this process (from sources): between frames, give the event loop a turn and look at the signal. */
async function inProcess(document: object, choice: FilmChoice, plan: ReturnType<typeof planFilm>, images: ImageSource | undefined, take: (rgb: Uint8Array, p: FilmProgress) => Promise<void>, signal: AbortSignal | undefined): Promise<Record<string, string> | null> {
  const { design } = await renderFrames(document, choice, plan, async (rgb, progress) => {
    await take(rgb, progress);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }, { ...(images === undefined ? {} : { images }), stopped: () => signal?.aborted === true });
  return design;
}

/**
 * Draw on the film thread: each frame taken, then the thread told to draw the next. The signal ends
 * the thread at once, wherever it is in a frame.
 */
function onThread(document: object, choice: FilmChoice, assets: FilmOptions['assets'], take: (rgb: Uint8Array, p: FilmProgress) => Promise<void>, signal: AbortSignal | undefined): Promise<Record<string, string> | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(THREAD, { workerData: { document, choice, ...(assets === undefined ? {} : { assets }) } });
    let settled = false;
    const end = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      void worker.terminate();
      fn();
    };
    const stop = () => { end(() => { reject(new FilmStopped()); }); };
    signal?.addEventListener('abort', stop, { once: true });
    worker.on('message', (m: { type: 'frame'; rgb: Uint8Array; progress: FilmProgress } | { type: 'done'; design: Record<string, string> | null } | { type: 'error'; message: string; range: boolean }) => {
      if (m.type === 'frame')
        take(m.rgb, m.progress).then(
          () => { if (!settled) worker.postMessage({ type: 'next' }); },
          (error: unknown) => { end(() => { reject(error instanceof Error ? error : new Error(String(error))); }); },
        );
      else if (m.type === 'done') end(() => { resolve(m.design); });
      else end(() => { reject(m.range ? new RangeError(m.message) : new Error(m.message)); });
    });
    worker.on('error', (error) => { end(() => { reject(error); }); });
    worker.on('exit', (code) => { end(() => { reject(new Error(`the film thread stopped (${String(code)})`)); }); });
  });
}
