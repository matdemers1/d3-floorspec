import { documentScenes, fNumber, viewCamera, type SavedView } from '@floorspec/mesh';
import { mapsFor, resolveLook, skyField, skyLight, sunDay, sunsetPlace, type LookRequest, type SkyLight } from '@floorspec/mesh/sky';
import type { PerspectiveCamera } from 'three';
import { requestExport, untilFinished, uploadStill, type ExportJob, type ExportRequest } from '../../../exports/api';
import type { EditorModel } from '../../model';
import { skyMaps } from '../sky/maps';
import { savedViewCamera } from '../still/gpu/cameras';
import { midnightOf } from '../sun/clock';
import { placedSite, siteOf, studyOf } from '../sun/study';
import type { TraceProgress } from '../still/gpu/tracer';
import { clockOfAt } from './views';

/**
 * A saved view traced on this device's GPU (FLR-T-13.10): the shot list's in-editor path. As the GPU
 * still does (FLR-T-13.13) — the version's glTF export with the view's levels and lights, traced by
 * three-gpu-pathtracer, denoised and saved to the version's exports — through the view's own camera
 * (its lens shift and thin lens), under its sky at its time, exposed with its compensation.
 */

/**
 * The sky a view is seen under: its preset, its sun placed at its `at` from the site (as the Sky and
 * sun panel places it) — in a season and a weather when asked (FLR-T-15.4; a weather sets the sky, as
 * the worker's renders do).
 */
export function skyOfView(model: EditorModel, view: SavedView, asked?: LookRequest): SkyLight {
  const site = placedSite(siteOf(model));
  const { sky, look } = resolveLook(view.sky, asked);
  if (sky === 'studio') return skyLight('studio', null, site.trueNorth, look);
  const clock = view.at === undefined ? null : clockOfAt(view.at);
  const lat = site.latitude ?? 0;
  const lon = site.longitude ?? 0;
  if (sky === 'dusk') return skyLight('dusk', clock === null ? null : (sunsetPlace(sunDay(midnightOf(clock), lat, lon), lat, lon) ?? null), site.trueNorth, look);
  const study = clock === null ? null : studyOf(site, clock);
  return skyLight(sky, study === null ? null : { azimuth: study.position.azimuth, altitude: study.position.altitude }, site.trueNorth, look);
}

/** The levels a view's glTF export holds: every one, or its level and those below, or its level alone. */
function levelsOf(model: EditorModel, view: SavedView): string[] | undefined {
  if (view.level === undefined) return undefined;
  if (view.levels === 'only') return [view.level];
  const at = model.levels.find((l) => l.id === view.level);
  return at === undefined ? undefined : model.levels.filter((l) => l.elevation <= at.elevation).map((l) => l.id);
}

export interface GpuShotRequest {
  readonly projectId: string;
  readonly model: EditorModel;
  readonly view: SavedView;
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly canvas: HTMLCanvasElement;
  readonly device: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (p: TraceProgress) => void;
  /** Exports already made in this run, by what they hold: views that share levels and lights share one. */
  readonly exports: Map<string, { job: ExportJob; glb: ArrayBuffer }>;
  /** FLR-T-15.4: the season, and rain or snow, every view is seen in (`lookRequest`'s). */
  readonly look?: Pick<ExportRequest, 'season' | 'weather'>;
}

export interface GpuShot {
  readonly png: Blob;
  readonly job: ExportJob | null;
  readonly saveError: string | null;
  readonly ms: number;
}

/** Trace one saved view on the GPU and save it to the version's exports. */
export async function shootOnGpu(r: GpuShotRequest): Promise<GpuShot> {
  const { model, view } = r;
  const design = Object.keys(model.design).length > 0 ? { ...model.design } : undefined;
  const lights = view.lights === 'on';
  const scene = view.scene === undefined ? undefined : documentScenes(model.view).find((s) => s.id === view.scene);
  const lighting = scene === undefined || 'all' in scene.lighting ? undefined : { on: Object.fromEntries(Object.entries(scene.lighting.on).map(([id, s]) => [id, { ...s }])) };
  const levels = levelsOf(model, view);
  const key = JSON.stringify([levels ?? null, lighting ?? null]);
  let made = r.exports.get(key);
  if (made === undefined) {
    const queued = await requestExport(r.projectId, { kind: 'gltf', doors: 'closed', ...(lighting === undefined ? {} : { lighting }), ...(levels === undefined ? {} : { levels }), ...(design === undefined ? {} : { design }), ...r.look });
    const job = await untilFinished(r.projectId, queued, () => undefined, r.signal);
    if (job.status !== 'done' || job.download === null) throw new Error(`the model was not exported: ${job.error ?? 'the worker gave no reason'}`);
    const res = await fetch(job.download, { credentials: 'same-origin', signal: r.signal });
    if (!res.ok) throw new Error(`the model could not be read (${String(res.status)})`);
    made = { job, glb: await res.arrayBuffer() };
    r.exports.set(key, made);
  }
  const [{ GLTFLoader }, scenes, { traceStill }] = await Promise.all([import('three/examples/jsm/loaders/GLTFLoader.js'), import('../still/gpu/scene'), import('../still/gpu/tracer')]);
  const gltf = await new GLTFLoader().parseAsync(made.glb.slice(0), '');
  const house = scenes.prepareHouse(gltf.scene, { lights, cut: view.level ?? null, roofs: view.level === undefined });
  const cam = viewCamera(view);
  const still = savedViewCamera(cam, view.focalLength, view.aperture === undefined ? null : fNumber(view.aperture));
  const light = skyOfView(model, view, r.look);
  const field = skyField(light, await skyMaps(mapsFor(light)));
  const { scene: traced, dispose } = scenes.stillScene(gltf.scene, house.bounds, { lights, sky: field });
  const camera: PerspectiveCamera = scenes.perspectiveOf(still, r.width / r.height);
  let out;
  try {
    out = await traceStill({ canvas: r.canvas, scene: traced, camera, width: r.width, height: r.height, samples: r.samples, time: light.band, signal: r.signal, exposureScale: cam.exposure, ...(r.onProgress === undefined ? {} : { onProgress: r.onProgress }) });
  } finally {
    dispose();
  }
  let job: ExportJob | null = null;
  let saveError: string | null = null;
  try {
    job = await uploadStill(r.projectId, out.png, { version: made.job.version, view: view.name, samples: r.samples, ms: out.ms, lights: lights ? 'on' : 'off', ...(scene === undefined ? (lights ? { scene: 'All on' } : {}) : { scene: scene.name }), time: light.band, sky: light.preset, device: r.device, ...(design === undefined ? {} : { design }), ...r.look });
  } catch (caught) {
    saveError = caught instanceof Error ? caught.message : String(caught);
  }
  return { png: out.png, job, saveError, ms: out.ms };
}
