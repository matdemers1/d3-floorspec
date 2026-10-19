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
 */
import { documentScenes, filmCameraAt, filmDuration, filmFrameCount, filmNamed, filmProblem, filmShots, filmsOf, filmViewOf, savedViewsOf, viewCamera, type Lighting, type SavedView } from '@floorspec/mesh';
import { midsummer, skyExposure, timelapseAround, timelapseSchedule, type Timelapse, type TimelapseSchedule } from '@floorspec/mesh/sky';
import type { FloorspecDocument } from '@floorspec/engine';
import { buildScene, type Scene } from '../export/gltf/scene.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { savedCamera } from '../render3d/camera.js';
import { encodePng } from '../render3d/png.js';
import { rasterize } from '../render3d/raster.js';
import { rasterSky, rasterStage } from '../render3d/index.js';
import { LUX_PER_UNIT, renderSceneStill } from '../pathtrace/index.js';
import { resolveSky, siteOf, type ResolvedSky } from '../pathtrace/sky.js';
import { inARoom } from '../pathtrace/views.js';
import { describeVideo, startEncoder, type VideoFacts } from './encode.js';
import { FILM_CONTENT_TYPES, FILM_SIZES, FINAL_FRAME_BUDGET_MS, filmChoiceProblem, finalSamples, MAX_FILM_BYTES, type FilmFormat, type FilmLight, type FilmQuality, type FilmRate, type FilmSize } from './presets.js';

export * from './presets.js';
export { describeVideo, ffmpegReady, startEncoder, type Encoder, type VideoFacts } from './encode.js';

export interface FilmOptions {
  /** The film, by its ID or name. */
  readonly film: string;
  readonly quality: FilmQuality;
  readonly format: FilmFormat;
  readonly size: FilmSize;
  readonly fps: FilmRate;
  readonly light: FilmLight;
  /** Day to night: the day and the clocks. Default two hours before the site's sunset on June 21 to an hour after. */
  readonly timelapse?: Timelapse;
  readonly design?: Record<string, string>;
  readonly images?: ImageSource;
  /** Override the frame's size, pixels (tests); even each way. */
  readonly pixels?: { readonly width: number; readonly height: number };
  /** Override a final frame's samples a pixel (tests). */
  readonly samples?: number;
  /** After each frame: how far it has got. Throwing stops the film (the job was cancelled). */
  readonly onFrame?: (progress: FilmProgress) => void | Promise<void>;
}

export interface FilmProgress {
  /** Frames done, and in all. */
  readonly frame: number;
  readonly frames: number;
  /** Day to night: the clock at the site in the frame just made, "7:12 pm". */
  readonly clock?: string;
  /** Now and then, the frame just made, small: a PNG data URL. */
  readonly preview?: string;
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

/** How long exposure takes to follow the frames, ms of film: a camera's auto exposure settling. */
const ADAPT_MS = 500;
/** The preview a job shows, pixels, and how often it is made (wall clock). */
const PREVIEW = { width: 192, height: 108, everyMs: 1500 } as const;

/** Exposure eased towards each frame's own, in stops: the first frame's at once. */
export class Adaptation {
  private value: number | null = null;
  constructor(private readonly ms = ADAPT_MS) {}
  next(target: number, dt: number): number {
    if (!(target > 0) || !Number.isFinite(target)) return this.value ?? 1;
    if (this.value === null) this.value = target;
    else {
      const k = 1 - Math.exp(-Math.max(0, dt) / this.ms);
      this.value = Math.exp(Math.log(this.value) + (Math.log(target) - Math.log(this.value)) * k);
    }
    return this.value;
  }
}

/** A frame shrunk to a preview: a box filter, then a PNG data URL. */
function previewOf(rgb: Uint8Array, width: number, height: number): string {
  const W = PREVIEW.width;
  const H = Math.max(1, Math.round((W * height) / width));
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * width) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / W));
      const y0 = Math.floor((y * height) / H);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / H));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = y0; j < y1; j++)
        for (let i = x0; i < x1; i++) {
          const o = 3 * (j * width + i);
          r += rgb[o] ?? 0;
          g += rgb[o + 1] ?? 0;
          b += rgb[o + 2] ?? 0;
        }
      const n = (x1 - x0) * (y1 - y0);
      const o = 3 * (y * W + x);
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  return `data:image/png;base64,${Buffer.from(encodePng(out, W, H)).toString('base64')}`;
}

/** The lighting a film's lamps are: its first saved view's scene, or every light. */
function lightingOf(document: object, first: SavedView | undefined): Lighting | undefined {
  if (first?.scene === undefined) return undefined;
  return documentScenes(document as FloorspecDocument).find((s) => s.id === first.scene)?.lighting;
}

/** Render a film to a video. Throws a RangeError for a film the document does not have, or cannot be rendered as asked. */
export async function renderFilm(document: object, options: FilmOptions): Promise<FilmResult> {
  const started = Date.now();
  const film = filmNamed(document, options.film);
  if (film === undefined) {
    const known = filmsOf(document).map((f) => `"${f.name}"`);
    throw new RangeError(`the model has no film "${options.film}"${known.length === 0 ? '; it has none — make one in the 3D view’s Camera panel' : `; its films are ${known.slice(0, 12).join(', ')}`}`);
  }
  const problem = filmProblem(film);
  if (problem !== null) throw new RangeError(`the film "${film.name}" cannot be rendered: ${problem}`);
  const views = savedViewsOf(document);
  const { shots, missing } = filmShots(film, views);
  if (missing.length > 0) throw new RangeError(`the film "${film.name}" names saved views the model does not have: ${missing.join(', ')}`);
  if (shots.length < 2) throw new RangeError(`the film "${film.name}" needs at least two keyframes`);
  const duration = filmDuration(film);
  const frames = filmFrameCount(duration, options.fps);
  const choice = filmChoiceProblem(options.quality, options.size, frames);
  if (choice !== null) throw new RangeError(choice);
  const [width, height] = options.pixels === undefined ? FILM_SIZES[options.size] : [options.pixels.width, options.pixels.height];
  const samples = options.quality === 'final' ? (options.samples ?? finalSamples(options.size) ?? 0) : undefined;

  // The light: the first saved view's, or day to night.
  const first = shots.find((s) => s.view !== undefined)?.view;
  const site = siteOf(document);
  const timelapse = options.light === 'day-to-night' ? (options.timelapse ?? timelapseAround(midsummer(new Date().getUTCFullYear()), site)) : undefined;
  const schedule: TimelapseSchedule | undefined = timelapse === undefined ? undefined : timelapseSchedule(timelapse, site);
  const lampsOn = timelapse !== undefined ? timelapse.lightsAtDusk : first?.lights === 'on';
  const lighting = lightingOf(document, first);
  const fixed: ResolvedSky | undefined = schedule === undefined ? resolveSky(document, { sky: first?.sky ?? 'clear', ...(first?.at === undefined ? {} : { at: first.at }) }) : undefined;

  // The doors open: a film walks through the house.
  const scene: Scene = await buildScene(document, {
    doors: 'open',
    ...(options.design === undefined ? {} : { design: options.design }),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(lighting === undefined ? {} : { lighting }),
  });
  const stage = options.quality === 'draft' ? rasterStage(scene, options.images) : null;
  const trueNorth = site.trueNorth;

  const encoder = await startEncoder({ width, height, fps: options.fps, format: options.format, quality: options.quality, title: film.name });
  const adapt = new Adaptation();
  const step = 1000 / options.fps;
  let previewAt = 0;
  try {
    for (let f = 0; f < frames; f++) {
      const t = f * step;
      const moment = schedule?.at(duration <= 0 ? 0 : t / duration);
      const sky = fixed ?? resolveSky(document, { sky: 'clear', ...(moment === undefined ? {} : { at: moment.at }) });
      const up = lampsOn ? (moment === undefined ? 1 : moment.lamps) : 0;
      const cam = filmCameraAt(shots, t);
      const vc = viewCamera(filmViewOf(cam));
      const camera = savedCamera(vc);
      const level = cam.level !== undefined && scene.levels.some((l) => l.id === cam.level) ? cam.level : undefined;
      const only = level !== undefined && cam.levels === 'only';
      let rgb: Uint8Array;
      if (stage !== null) {
        // A draft: the sky's own exposure, eased; the lamps of the levels drawn, at how far up they are.
        const lit = rasterSky(sky, stage.groundY);
        const exposure = adapt.next(skyExposure(sky.light, sky.field.maps), f === 0 ? 0 : step);
        rgb = rasterize(stage.list(level, only), camera, {
          width,
          height,
          // One sample a pixel: a draft is for checking timing and framing.
          supersample: 1,
          lighting: { ...lit, exposure },
          exposureScale: vc.exposure,
          lamps: up > 0 ? stage.lamps(level, only) : [],
          glow: up,
        });
      } else {
        const still = await renderSceneStill(scene, {
          skyLight: sky,
          shot: { camera, inside: inARoom(scene, vc.eye) },
          ...(level === undefined ? {} : { level, ...(only ? { only: true } : {}) }),
          pixels: { width, height },
          samples: samples ?? 1,
          budgetMs: FINAL_FRAME_BUDGET_MS,
          lights: up > 0 ? 'on' : 'off',
          lampScale: up,
          trueNorth,
          exposureScale: vc.exposure,
          adapt: (metered) => adapt.next(metered / LUX_PER_UNIT, f === 0 ? 0 : step) * LUX_PER_UNIT,
          ...(options.images === undefined ? {} : { images: options.images }),
          rgb: true,
        });
        if (still.rgb === undefined) throw new Error('the path tracer gave back no picture');
        rgb = still.rgb;
      }
      await encoder.write(rgb);
      const now = Date.now();
      const preview = now - previewAt >= PREVIEW.everyMs || f === frames - 1 ? previewOf(rgb, width, height) : undefined;
      if (preview !== undefined) previewAt = now;
      await options.onFrame?.({ frame: f + 1, frames, ...(moment === undefined ? {} : { clock: moment.clock }), ...(preview === undefined ? {} : { preview }) });
    }
  } catch (error) {
    await encoder.abort();
    throw error;
  }
  const bytes = await encoder.finish();
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
    design: scene.design,
    ms: Date.now() - started,
  };
}
