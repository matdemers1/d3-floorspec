/**
 * A virtual tour (FLR-T-14.2, FLR-ADR-057): a 360° panorama of every toured room, path-traced at eye
 * height from the room's visual centre or a saved view's eye (pano.ts, place.ts), each an
 * equirectangular JPEG; a hotspot at each doorway to the next toured room; each level's plan in both
 * themes for the viewer's map; and the manifest that ties them together (@floorspec/mesh tour.ts).
 * The worker's `export.tour` job: the manifest is the job's file, the panoramas and plans its assets.
 *
 * One light for every room — a clear sky at three on midsummer's afternoon, at the site, the lamps
 * off — and the doors open, so a doorway shows the room it leads to.
 */
import { evaluate, OFFICIAL_READER } from '@floorspec/engine';
import { DEFAULT_EYE_HEIGHT, MAX_TOUR_ROOMS, savedViewNamed, TOUR_QUALITIES, TOUR_SIZES, TOUR_SKY, tourFace, tourRoomsByDefault, tourWithinBudget, UNITS_PER_METRE, viewCamera, yawPitch, type Point3, type TourLevel, type TourManifest, type TourQuality, type TourRoom, type TourSize } from '@floorspec/mesh';
import { BU_PER_FOOT, renderEvaluation } from '@floorspec/render2d';
import { buildScene, type Scene, type SceneOptions, type SceneRoom } from '../export/gltf/scene.js';
import type { ImageSource } from '../export/gltf/glb.js';
import { withLibrary } from '../export/gltf/library.js';
import { directOf, EXPOSURE, LUX_PER_UNIT, ptScene, SEED, texturesOf } from '../pathtrace/index.js';
import { BUDGET_MS } from '../pathtrace/presets.js';
import { groundOf, resolveSky, skySummary, type SkySummary } from '../pathtrace/sky.js';
import { findRoom } from '../render3d/camera.js';
import { encodeJpeg } from './jpeg.js';
import { renderPano } from './pano.js';
import { eyeZ, headingOf, hotspotsOf, linksOf, round, visualCentre } from './place.js';

export { encodeJpeg } from './jpeg.js';
export { renderPano, resample, FACES, faceFov, basisOf } from './pano.js';
export { visualCentre, linksOf, hotspotsOf, eyeZ } from './place.js';

/** A room to tour, by ID or name, and where it is seen from: its centre, or a saved view's eye (by ID or name). */
export interface TourStop {
  readonly room: string;
  readonly view?: string;
}

export interface TourOptions {
  /** The rooms, in the tour's order (the first opens it). Default: every room but garages, closets and the outdoors. */
  readonly rooms?: readonly TourStop[];
  readonly size?: TourSize;
  readonly quality?: TourQuality;
  /** Above each room's floor, base units. Default 5'-3". */
  readonly eyeHeight?: number;
  /** The date and time at the site every panorama is seen at (presets.ts `AT_PATTERN`). */
  readonly at: string;
  readonly design?: Record<string, string>;
  readonly reader?: SceneOptions['reader'];
  readonly images?: ImageSource;
  /** The version, for the manifest. */
  readonly version?: { readonly hash: string; readonly seq: number | null };
  /** Called as each panorama's faces and passes go: never awaited, never thrown from. */
  readonly onPano?: (progress: TourProgress) => void;
  readonly signal?: AbortSignal;
  /** Override a cube face's side and the samples (tests). */
  readonly face?: number;
  readonly samples?: number;
}

export interface TourProgress {
  /** The panorama being made, from 1, of all of them, and its room's name. */
  readonly pano: number;
  readonly panos: number;
  readonly room: string;
  /** Its cube face, from 1, of six, and the passes done of that face. */
  readonly face: number;
  readonly faces: number;
  readonly pass: number;
  readonly passes: number;
}

export interface TourFile {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface TourResult {
  readonly manifest: TourManifest;
  /** The panoramas and the plans, by the paths the manifest names. */
  readonly files: readonly TourFile[];
  readonly sky: SkySummary;
  readonly design: Record<string, string> | null;
  readonly threads: number;
  readonly ms: number;
}

/** A tour was cancelled: nothing it made is kept. */
export class TourStopped extends Error {
  constructor() {
    super('the tour was cancelled');
    this.name = 'TourStopped';
  }
}

const M = UNITS_PER_METRE;
/** The map's drawing scale, SVG pixels a foot: the whole floor in a phone's width, and sharp when the sheet is pinched up. */
const PLAN_SCALE = 12;
/** A panorama's JPEG quality. */
const JPEG_QUALITY = 85;

/** A file-safe name: "kitchen-r8". */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'room';

/** The rooms a tour visits when none are named (@floorspec/mesh `tourRoomsByDefault`), in the design drawn. */
export function defaultStops(document: object, design?: Record<string, string>): TourStop[] {
  const ev = evaluate(document, design === undefined ? OFFICIAL_READER : { ...OFFICIAL_READER, design });
  const doc = ev.view ?? ev.document;
  return doc === undefined ? [] : tourRoomsByDefault(doc).map((room) => ({ room }));
}

/** Where a level's plan puts a point: the first vertex of a room's floor, in the SVG and in metres. */
export function planFrame(svg: string, room: SceneRoom): { x0: number; y0: number; s: number } | undefined {
  const id = room.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<path data-id="${id}"[^>]*? d="M([-\\d.]+) ([-\\d.]+)`).exec(svg);
  if (m === null) return undefined;
  const s = (PLAN_SCALE / BU_PER_FOOT) * M;
  const [x, y] = room.outer[0]!;
  return { x0: round(Number(m[1]) - s * x, 3), y0: round(Number(m[2]) + s * y, 3), s: round(s, 6) };
}

const sizeOf = (svg: string): [number, number] => {
  const m = /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svg);
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
};

/** Render a tour of a version. Throws a RangeError for an unknown room or view, or for work over the budget. */
export async function renderTour(document: object, options: TourOptions): Promise<TourResult> {
  const started = Date.now();
  const size = options.size ?? 'large';
  const quality = options.quality ?? 'standard';
  if (!Object.hasOwn(TOUR_SIZES, size)) throw new RangeError(`size is one of ${Object.keys(TOUR_SIZES).join(', ')}`);
  if (!Object.hasOwn(TOUR_QUALITIES, quality)) throw new RangeError(`quality is one of ${Object.keys(TOUR_QUALITIES).join(', ')}`);
  if (!tourWithinBudget(size, quality)) throw new RangeError(`a ${size} panorama at ${quality} quality is more work than a still may take`);
  const eyeHeight = options.eyeHeight ?? DEFAULT_EYE_HEIGHT;
  const stops = options.rooms ?? defaultStops(document, options.design);
  if (stops.length === 0) throw new RangeError('the tour has no rooms to visit');
  if (stops.length > MAX_TOUR_ROOMS) throw new RangeError(`a tour visits at most ${String(MAX_TOUR_ROOMS)} rooms`);

  const scene: Scene = await buildScene(document, { ...(options.design === undefined ? {} : { design: options.design }), ...(options.reader === undefined ? {} : { reader: options.reader }), doors: 'open' });
  // The rooms, found, each once.
  const seen = new Set<string>();
  const tour: { room: SceneRoom; view?: string }[] = [];
  for (const stop of stops) {
    const room = findRoom(scene.rooms, stop.room);
    if (room === undefined) throw new RangeError(`the model has no room ${stop.room}`);
    if (seen.has(room.id)) continue;
    seen.add(room.id);
    tour.push({ room, ...(stop.view === undefined ? {} : { view: stop.view }) });
  }
  const levelName = new Map(scene.levels.map((l) => [l.id, l.name ?? l.id]));

  // One light for every room: the sky at the site at `at`, the sun its direct light.
  const sky = resolveSky(document, { sky: TOUR_SKY, at: options.at });
  const maps = texturesOf(scene, withLibrary(options.images));
  const pt = ptScene(scene, { textures: maps.textures, plate: false });
  const band = EXPOSURE[sky.light.band];
  const traceLight = {
    sun: directOf(sky),
    seed: SEED,
    budgetMs: BUDGET_MS,
    field: { sky: sky.field, unit: LUX_PER_UNIT },
    ground: { y: pt.floor, ...groundOf(sky.light) },
    clamp: 12 * (EXPOSURE.day.min / band.min),
  };
  const face = options.face ?? tourFace(size);
  const width = 4 * face;
  const samples = options.samples ?? TOUR_QUALITIES[quality];
  const links = linksOf(scene, seen);
  const toured = tour.map((t) => t.room);

  const files: TourFile[] = [];
  const rooms: TourRoom[] = [];
  let threads = 1;
  for (const [i, { room, view }] of tour.entries()) {
    if (options.signal?.aborted === true) throw new TourStopped();
    const name = room.name ?? room.id;
    let eye: Point3;
    let heading: number | undefined;
    let stands: TourRoom['stands'] = { at: 'centre' };
    if (view !== undefined) {
      const saved = savedViewNamed(document, view);
      if (saved === undefined) throw new RangeError(`the model has no saved view "${view}"`);
      const cam = viewCamera(saved);
      eye = [cam.eye[0], cam.eye[1], cam.eye[2]];
      heading = round(yawPitch(cam.eye, cam.look).yaw);
      stands = { at: 'view', view: saved.name };
    } else {
      const z = eyeZ(room, eyeHeight / M);
      const at = visualCentre(room, scene.obstacles, z);
      eye = [at[0], at[1], z];
    }
    const hotspots = hotspotsOf(room, eye, links, toured);
    const pano = await renderPano(pt, eye, {
      face,
      width,
      samples,
      trace: traceLight,
      exposure: band,
      label: name,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onFace: (f, faces, pass, passes) => {
        try {
          options.onPano?.({ pano: i + 1, panos: tour.length, room: name, face: f + 1, faces, pass, passes });
        } catch {
          // Progress is advisory.
        }
      },
    }).catch((error: unknown) => {
      if (options.signal?.aborted === true) throw new TourStopped();
      throw error;
    });
    threads = pano.threads;
    const path = `pano-${String(i + 1).padStart(2, '0')}-${slug(room.id)}.jpg`;
    files.push({ path, contentType: 'image/jpeg', bytes: encodeJpeg(pano.rgb, pano.width, pano.height, JPEG_QUALITY) });
    rooms.push({
      id: room.id,
      name,
      level: room.level,
      pano: path,
      eye: [round(eye[0]), round(eye[1]), round(eye[2])],
      heading: heading ?? hotspots[0]?.yaw ?? headingOf(room, eye),
      stands,
      hotspots,
    });
  }

  // Each level's plan, for the map: the colour plan in each theme, without its labels (the viewer pins the rooms).
  const ev = evaluate(document, options.design === undefined ? OFFICIAL_READER : { ...OFFICIAL_READER, design: options.design });
  const levels: TourLevel[] = [];
  for (const level of scene.levels) {
    const here = toured.filter((r) => r.level === level.id);
    if (here.length === 0) continue;
    const plans = (['light', 'dark'] as const).map((theme) => renderEvaluation(ev, { level: level.id, style: 'colour', theme, labels: false, dimensions: false, scale: PLAN_SCALE }));
    const frame = here.map((r) => planFrame(plans[0]!, r)).find((f) => f !== undefined);
    if (frame === undefined) throw new Error(`the plan of ${level.id} does not draw its rooms`);
    const [w, h] = sizeOf(plans[0]!);
    const light = `plan-${slug(level.id)}-light.svg`;
    const dark = `plan-${slug(level.id)}-dark.svg`;
    files.push({ path: light, contentType: 'image/svg+xml', bytes: new TextEncoder().encode(plans[0]) });
    files.push({ path: dark, contentType: 'image/svg+xml', bytes: new TextEncoder().encode(plans[1]) });
    levels.push({ id: level.id, name: levelName.get(level.id) ?? level.id, plan: { light, dark, width: w, height: h, frame } });
  }

  const manifest: TourManifest = {
    tour: 1,
    project: scene.project,
    version: options.version ?? { hash: '', seq: null },
    start: rooms[0]!.id,
    width,
    height: width / 2,
    quality,
    samples,
    eyeHeight,
    light: { sky: TOUR_SKY, at: options.at },
    levels,
    rooms,
  };
  return { manifest, files, sky: skySummary(sky), design: scene.design, threads, ms: Date.now() - started };
}
