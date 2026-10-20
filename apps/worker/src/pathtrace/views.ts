/**
 * Saved views, rendered (FLR-T-13.10, FS_views 0.1.0): a view the document keeps — its camera, lens,
 * frame, cutaway, sky, time and lights — path-traced as the photograph it describes, by name
 * (`floorspec_render` with `view`), and a shot list: every saved view as a still, in one job.
 *
 * Path-traced, not rasterized: a saved view is a photograph, with its depth of field, its exposure
 * and, when its lights are on, its lamps. The camera is @floorspec/mesh's `viewCamera`, the same the
 * editor's 3D view and its GPU still look through; its lens shift (two-point perspective) and its
 * thin lens are the tracer's (trace.ts).
 */
import { buildScene, type Scene, type SceneOptions } from '../export/gltf/scene.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { inside, savedCamera } from '../render3d/camera.js';
import { documentScenes, pictureSize, savedViewNamed, savedViewsOf, viewCamera, type SavedView } from '@floorspec/mesh';
import type { FloorspecDocument } from '@floorspec/engine';
import { renderSceneStill, LIT_BUDGET_MS, LIT_DAY_SAMPLES, LIT_SAMPLES, type StillResult } from './index.js';
import { BUDGET_MS, MAX_SHOTS, QUALITIES, SHOT_SIZES, shotWithinBudget, VIEW_MAX_WIDTH, VIEW_WIDTH, type Quality, type ShotSize } from './presets.js';
import { resolveSky } from './sky.js';

export interface ViewRenderOptions {
  readonly design?: Record<string, string>;
  readonly reader?: SceneOptions['reader'];
  readonly images?: ImageSource;
  readonly doors?: SceneOptions['doors'];
  readonly onPass?: (done: number, total: number) => void | Promise<void>;
  /** Also give back the picture as eight-bit RGB (a matched pair's composites, FLR-T-14.4). */
  readonly rgb?: boolean;
}

/** The view, or a RangeError naming the views the document has. */
export function viewOf(document: object, key: string): SavedView {
  const view = savedViewNamed(document, key);
  if (view !== undefined) return view;
  const known = savedViewsOf(document).map((v) => `"${v.name}"`);
  throw new RangeError(`the model has no saved view "${key}"${known.length === 0 ? '; it has none — save one in the 3D view, or with setProperty of $document (FS_views)' : `; its views are ${known.slice(0, 24).join(', ')}`}`);
}

/** Whether a point (metres, the document's frame) stands in one of the scene's rooms, between its floor and ceiling. */
export function inARoom(scene: Scene, p: readonly [number, number, number]): boolean {
  return scene.rooms.some((r) => p[2] >= r.floor - 0.01 && p[2] <= r.ceiling + 0.01 && inside([p[0], p[1]], r.outer));
}

/** The scene a view is built from: its design, its doors and — with a document scene — its lighting. */
export async function sceneFor(document: object, view: SavedView, options: ViewRenderOptions): Promise<Scene> {
  const lighting = view.scene === undefined ? undefined : documentScenes(document as FloorspecDocument).find((s) => s.id === view.scene)?.lighting;
  return buildScene(document, {
    ...(options.design === undefined ? {} : { design: options.design }),
    ...(options.reader === undefined ? {} : { reader: options.reader }),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.doors === undefined ? {} : { doors: options.doors }),
    ...(lighting === undefined ? {} : { lighting }),
  });
}

/** Path-trace one view of a built scene at a long side and a number of samples a pixel. */
export async function shoot(document: object, scene: Scene, view: SavedView, long: number, samples: number | 'lit', budgetMs: number, options: ViewRenderOptions): Promise<StillResult> {
  if (view.level !== undefined && !scene.levels.some((l) => l.id === view.level)) throw new RangeError(`the view "${view.name}" cuts away at the level ${view.level}, which the model does not draw`);
  const site = (document as { site?: { trueNorth?: unknown } }).site;
  const trueNorth = typeof site?.trueNorth === 'number' ? site.trueNorth / 1e6 : 0;
  const skyLight = resolveSky(document, { sky: view.sky, ...(view.at === undefined ? {} : { at: view.at }) });
  const cam = viewCamera(view);
  const [width, height] = pictureSize(long, view.aspect);
  const day = skyLight.light.band === 'day';
  return renderSceneStill(scene, {
    skyLight,
    shot: { camera: savedCamera(cam), inside: inARoom(scene, cam.eye) },
    ...(view.level === undefined ? {} : { level: view.level, ...(view.levels === 'only' ? { only: true } : {}) }),
    pixels: { width, height },
    samples: samples === 'lit' ? (day ? LIT_DAY_SAMPLES : LIT_SAMPLES) : samples,
    budgetMs,
    lights: view.lights,
    ...(view.scene === undefined ? {} : { scene: documentScenes(document as FloorspecDocument).find((s) => s.id === view.scene)?.name ?? view.scene }),
    trueNorth,
    exposureScale: cam.exposure,
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.onPass === undefined ? {} : { onPass: options.onPass }),
    ...(options.rgb === true ? { rgb: true } : {}),
  });
}

/**
 * A saved view, by its name or ID, path-traced as an agent's render is (floorspec_render with
 * `view`): a few samples a pixel, denoised, `width` along its long side (default 800).
 */
export async function renderSavedView(document: object, key: string, options: ViewRenderOptions & { readonly width?: number } = {}): Promise<StillResult & { readonly view: SavedView }> {
  const long = options.width ?? VIEW_WIDTH;
  if (!Number.isInteger(long) || long < 64 || long > VIEW_MAX_WIDTH) throw new RangeError(`a saved view is rendered 64 to ${String(VIEW_MAX_WIDTH)} pixels along its long side`);
  const view = viewOf(document, key);
  const scene = await sceneFor(document, view, options);
  return { ...(await shoot(document, scene, view, long, 'lit', LIT_BUDGET_MS, options)), view };
}

export interface ShotListOptions extends ViewRenderOptions {
  /** The views to render, by ID; default every saved view, in ID order. */
  readonly views?: readonly string[];
  readonly size?: ShotSize;
  readonly quality?: Quality;
  /** Override the long side, pixels, and the samples a pixel (tests). */
  readonly long?: number;
  readonly samples?: number;
  /** Called as each shot starts and as its passes go. */
  readonly onShot?: (shot: number, shots: number, pass: number, passes: number) => void | Promise<void>;
}

export interface Shot {
  readonly view: SavedView;
  readonly still: StillResult;
}

/**
 * A shot list (FLR-T-13.10): every saved view (or those named) path-traced as a still, one after
 * another on this worker — one job, so it takes one of the project's render places, not one each.
 */
export async function renderShots(document: object, options: ShotListOptions = {}): Promise<Shot[]> {
  const size = options.size ?? 'medium';
  const quality = options.quality ?? 'standard';
  if (!Object.hasOwn(SHOT_SIZES, size)) throw new RangeError(`size is one of ${Object.keys(SHOT_SIZES).join(', ')}`);
  if (!Object.hasOwn(QUALITIES, quality)) throw new RangeError(`quality is one of ${Object.keys(QUALITIES).join(', ')}`);
  if (!shotWithinBudget(size, quality)) throw new RangeError(`a ${size} shot at ${quality} quality is more work than a still may take: choose a smaller size or a lower quality`);
  const all = savedViewsOf(document);
  const views = options.views === undefined ? all : options.views.map((id) => all.find((v) => v.id === id) ?? viewOf(document, id));
  if (views.length === 0) throw new RangeError('the model has no saved views to render');
  if (views.length > MAX_SHOTS) throw new RangeError(`a shot list renders at most ${String(MAX_SHOTS)} views`);
  const shots: Shot[] = [];
  // One scene for every view that shares its lighting; a view with a scene of its own gets its own.
  const built = new Map<string, Scene>();
  for (const [i, view] of views.entries()) {
    const key = view.scene ?? '';
    let scene = built.get(key);
    if (scene === undefined) {
      scene = await sceneFor(document, view, options);
      built.set(key, scene);
    }
    const samples = options.samples ?? QUALITIES[quality];
    await options.onShot?.(i, views.length, 0, samples);
    const still = await shoot(document, scene, view, options.long ?? SHOT_SIZES[size], samples, BUDGET_MS, {
      ...options,
      onPass: (done, total) => options.onShot?.(i, views.length, done, total),
    });
    shots.push({ view, still });
  }
  return shots;
}
