/**
 * A film's frames (FLR-T-14.1, FLR-T-14.10): the plan — the film checked and its frames, size and
 * light worked out, cheaply, before anything is drawn — and the loop that draws each frame and hands
 * it on. The loop runs on a thread of its own (thread.ts) so the process that holds the job — the
 * worker, or the api draining inline — keeps answering while a frame is drawn, and a cancelled film
 * is stopped mid-frame; run from TypeScript sources (the tests) it runs in-process.
 */
import { documentScenes, filmCameraAt, filmDuration, filmFrameCount, filmNamed, filmProblem, filmShots, filmsOf, filmViewOf, savedViewsOf, viewCamera, type Film, type FilmShot, type Lighting, type SavedView } from '@floorspec/mesh';
import { midsummer, skyExposure, timelapseAround, timelapseSchedule, type LookRequest, type Timelapse, type TimelapseSchedule } from '@floorspec/mesh/sky';
import type { FloorspecDocument } from '@floorspec/engine';
import { buildScene, type Scene } from '../export/gltf/scene.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { savedCamera } from '../render3d/camera.js';
import { encodePng } from '../render3d/png.js';
import { rasterize } from '../render3d/raster.js';
import { rasterSky, rasterStage } from '../render3d/index.js';
import { lookOption, LUX_PER_UNIT, renderSceneStill } from '../pathtrace/index.js';
import { resolveSky, siteOf, type ResolvedSky } from '../pathtrace/sky.js';
import { inARoom } from '../pathtrace/views.js';
import { FILM_SIZES, FINAL_FRAME_BUDGET_MS, filmChoiceProblem, finalSamples, type FilmFormat, type FilmLight, type FilmQuality, type FilmRate, type FilmSize } from './presets.js';

/** What a film is asked to be: everything a thread can be handed (no functions). */
export interface FilmChoice {
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
  /** Override the frame's size, pixels (tests); even each way. */
  readonly pixels?: { readonly width: number; readonly height: number };
  /** Override a final frame's samples a pixel (tests). */
  readonly samples?: number;
  /**
   * The season and the weather it is filmed in (FLR-T-15.4): looks over every frame. A weather sets
   * each frame's sky (rain and snow an overcast one); without one, each keyframe's own.
   */
  readonly look?: LookRequest;
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

/** A film checked and worked out. */
export interface FilmPlan {
  readonly film: Film;
  readonly shots: FilmShot[];
  readonly duration: number;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly samples?: number;
  readonly first?: SavedView;
  readonly timelapse?: Timelapse;
  readonly schedule?: TimelapseSchedule;
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


/** Check a film and work it out. Throws a RangeError for a film the document does not have, or cannot be rendered as asked. */
export function planFilm(document: object, choice: FilmChoice): FilmPlan {
  const film = filmNamed(document, choice.film);
  if (film === undefined) {
    const known = filmsOf(document).map((f) => `"${f.name}"`);
    throw new RangeError(`the model has no film "${choice.film}"${known.length === 0 ? '; it has none — make one in the 3D view’s Camera panel' : `; its films are ${known.slice(0, 12).join(', ')}`}`);
  }
  const problem = filmProblem(film);
  if (problem !== null) throw new RangeError(`the film "${film.name}" cannot be rendered: ${problem}`);
  const { shots, missing } = filmShots(film, savedViewsOf(document));
  if (missing.length > 0) throw new RangeError(`the film "${film.name}" names saved views the model does not have: ${missing.join(', ')}`);
  if (shots.length < 2) throw new RangeError(`the film "${film.name}" needs at least two keyframes`);
  const duration = filmDuration(film);
  const frames = filmFrameCount(duration, choice.fps);
  const refused = filmChoiceProblem(choice.quality, choice.size, frames);
  if (refused !== null) throw new RangeError(refused);
  const [width, height] = choice.pixels === undefined ? FILM_SIZES[choice.size] : [choice.pixels.width, choice.pixels.height];
  const samples = choice.quality === 'final' ? (choice.samples ?? finalSamples(choice.size) ?? 1) : undefined;
  const first = shots.find((s) => s.view !== undefined)?.view;
  const site = siteOf(document);
  const timelapse = choice.light === 'day-to-night' ? (choice.timelapse ?? timelapseAround(midsummer(new Date().getUTCFullYear()), site)) : undefined;
  return {
    film,
    shots,
    duration,
    frames,
    width,
    height,
    ...(samples === undefined ? {} : { samples }),
    ...(first === undefined ? {} : { first }),
    ...(timelapse === undefined ? {} : { timelapse, schedule: timelapseSchedule(timelapse, site) }),
  };
}

/**
 * Draw every frame of a planned film, handing each on — its pixels and how far the film has got —
 * and waiting for it to be taken before drawing the next. Stops between frames once `stopped` says so.
 * Resolves with the design it was drawn in.
 */
export async function renderFrames(
  document: object,
  choice: FilmChoice,
  plan: FilmPlan,
  emit: (rgb: Uint8Array, progress: FilmProgress) => Promise<void>,
  options: { readonly images?: ImageSource; readonly stopped?: () => boolean } = {},
): Promise<{ design: Record<string, string> | null }> {
  const { shots, duration, frames, width, height, samples, first, timelapse, schedule } = plan;
  const site = siteOf(document);
  const lampsOn = timelapse !== undefined ? timelapse.lightsAtDusk : first?.lights === 'on';
  const lighting = lightingOf(document, first);
  const fixed: ResolvedSky | undefined = schedule === undefined ? resolveSky(document, { sky: first?.sky ?? 'clear', ...(first?.at === undefined ? {} : { at: first.at }), ...choice.look }) : undefined;
  const images = options.images;
  // The doors open: a film walks through the house.
  const scene: Scene = await buildScene(document, {
    doors: 'open',
    ...(choice.design === undefined ? {} : { design: choice.design }),
    ...(images === undefined ? {} : { images }),
    ...(lighting === undefined ? {} : { lighting }),
    ...lookOption(choice.look),
  });
  const stage = choice.quality === 'draft' ? rasterStage(scene, images) : null;
  const adapt = new Adaptation();
  const step = 1000 / choice.fps;
  let previewAt = 0;
  for (let f = 0; f < frames; f++) {
    if (options.stopped?.() === true) break;
    const t = f * step;
    const moment = schedule?.at(duration <= 0 ? 0 : t / duration);
    const sky = fixed ?? resolveSky(document, { sky: 'clear', ...(moment === undefined ? {} : { at: moment.at }), ...choice.look });
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
        trueNorth: site.trueNorth,
        exposureScale: vc.exposure,
        adapt: (metered) => adapt.next(metered / LUX_PER_UNIT, f === 0 ? 0 : step) * LUX_PER_UNIT,
        ...(images === undefined ? {} : { images }),
        rgb: true,
      });
      if (still.rgb === undefined) throw new Error('the path tracer gave back no picture');
      rgb = still.rgb;
    }
    const now = Date.now();
    const preview = now - previewAt >= PREVIEW.everyMs || f === frames - 1 ? previewOf(rgb, width, height) : undefined;
    if (preview !== undefined) previewAt = now;
    await emit(rgb, { frame: f + 1, frames, ...(moment === undefined ? {} : { clock: moment.clock }), ...(preview === undefined ? {} : { preview }) });
  }
  return { design: scene.design };
}
