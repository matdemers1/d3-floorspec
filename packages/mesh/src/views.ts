/**
 * Saved views (FLR-T-13.10, FS_views 0.1.0): the photographs a house is meant to be seen in — a named
 * camera with its lens, its frame, how the house is cut away, the sky and the time, and which lights
 * are on — and the one camera every view makes of one: the editor's 3D view, the headless render, the
 * worker's path tracer and the GPU still.
 *
 * A view is kept in the document (`extensions.FS_views.views`, FLR-ADR-046): the owner keeps it, and an
 * agent renders it by name (`floorspec_render` with `view`). Its eye and target are exact lengths;
 * everything here turns them into metres once, at the end.
 *
 * The lens is a 35 mm camera's: the picture's long side spans 36 mm, so a focal length gives the
 * same field of view across the long side whatever the frame's shape. Two-point perspective holds
 * the camera level and shifts its lens up or down so the target stays in the middle of the picture —
 * a shift lens's rising front — and vertical lines stay vertical. Depth of field is a thin lens of
 * that focal length at the f-number; exposure compensation multiplies the exposure a view is
 * metered to by 2^(tenths / 10).
 */
import type { FloorspecDocument } from '@floorspec/engine';
import type { SkyPreset } from './sky/sky.js';
import { UNITS_PER_METRE } from './types.js';

export const ASPECTS = ['3:2', '16:9', '4:5', '1:1'] as const;
export type Aspect = (typeof ASPECTS)[number];
/** Width over height. */
export const ASPECT_RATIOS: Readonly<Record<Aspect, number>> = { '3:2': 3 / 2, '16:9': 16 / 9, '4:5': 4 / 5, '1:1': 1 };

export const APERTURES = ['f/1.4', 'f/2', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11', 'f/16', 'f/22'] as const;
export type Aperture = (typeof APERTURES)[number];
/** The f-number of an aperture. */
export const fNumber = (a: Aperture): number => Number(a.slice(2));

/** The skies a view may be seen under (`@floorspec/mesh/sky`'s presets, named here so this module loads none of the sky). */
const SKY_PRESETS: readonly SkyPreset[] = ['clear', 'overcast', 'dusk', 'night', 'studio'];

export const LEVELS_SHOWN = ['cutaway', 'only'] as const;
export type ViewLevels = (typeof LEVELS_SHOWN)[number];

/** FS_views 2.1's bounds and defaults. */
export const FOCAL_MIN = 8;
export const FOCAL_MAX = 1200;
export const DEFAULT_FOCAL = 35;
export const EXPOSURE_MIN = -30;
export const EXPOSURE_MAX = 30;
/** The long side of the frame a focal length is given on: 36 mm, a 35 mm camera's. */
export const FRAME_LONG_MM = 36;
/** How far up or down a two-point view may look before its lens shift is given up (FS-VIEW-LINT-001 warns past 30°). */
const SHIFT_MAX_SLOPE = 20;

/** A view as FS_views records it, with its defaults filled in. Lengths are base units (1/1280 mm). */
export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly focalLength: number;
  readonly twoPoint: boolean;
  readonly aspect: Aspect;
  readonly aperture?: Aperture;
  /** Base units; absent: the distance from the eye to the target. */
  readonly focus?: number;
  /** Tenths of a stop. */
  readonly exposure: number;
  readonly level?: string;
  readonly levels: ViewLevels;
  readonly sky: SkyPreset;
  readonly at?: string;
  readonly lights: 'off' | 'on';
  readonly scene?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPoint = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** FS_views' records, when the document declares FS_views; else an empty object. */
export function viewsData(doc: FloorspecDocument | object): Record<string, Json> {
  const used = (doc as { extensionsUsed?: unknown }).extensionsUsed;
  if (!isObject(used) || !Object.hasOwn(used, 'FS_views')) return {};
  const data = ((doc as { extensions?: unknown }).extensions as Json | undefined)?.['FS_views'];
  return isObject(data) && isObject(data['views']) ? (data['views'] as Record<string, Json>) : {};
}

/** One record read as a view, its defaults filled in; undefined when it is not one (a reader reads what it can). */
export function readView(id: string, v: unknown): SavedView | undefined {
  if (!isObject(v) || typeof v['name'] !== 'string' || !isPoint(v['eye']) || !isPoint(v['target'])) return undefined;
  const pick = <T extends string>(x: unknown, of: readonly T[], d: T): T => (typeof x === 'string' && (of as readonly string[]).includes(x) ? (x as T) : d);
  const int = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  const aperture = typeof v['aperture'] === 'string' && (APERTURES as readonly string[]).includes(v['aperture']) ? (v['aperture'] as Aperture) : undefined;
  const focus = typeof v['focus'] === 'number' && Number.isInteger(v['focus']) && v['focus'] > 0 ? v['focus'] : undefined;
  return {
    id,
    name: v['name'],
    eye: [v['eye'][0], v['eye'][1], v['eye'][2]],
    target: [v['target'][0], v['target'][1], v['target'][2]],
    focalLength: int(v['focalLength'], FOCAL_MIN, FOCAL_MAX, DEFAULT_FOCAL),
    twoPoint: v['twoPoint'] === true,
    aspect: pick(v['aspect'], ASPECTS, '3:2'),
    ...(aperture === undefined ? {} : { aperture }),
    ...(aperture === undefined || focus === undefined ? {} : { focus }),
    exposure: int(v['exposure'], EXPOSURE_MIN, EXPOSURE_MAX, 0),
    ...(typeof v['level'] === 'string' ? { level: v['level'] } : {}),
    levels: typeof v['level'] === 'string' ? pick(v['levels'], LEVELS_SHOWN, 'cutaway') : 'cutaway',
    sky: pick(v['sky'], SKY_PRESETS, 'clear'),
    ...(typeof v['at'] === 'string' ? { at: v['at'] } : {}),
    lights: typeof v['scene'] === 'string' || v['lights'] === 'on' ? 'on' : 'off',
    ...(typeof v['scene'] === 'string' ? { scene: v['scene'] } : {}),
  };
}

/** The document's saved views, in ID order. */
export function savedViewsOf(doc: FloorspecDocument | object): SavedView[] {
  return Object.entries(viewsData(doc))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([id, v]) => readView(id, v) ?? []);
}

/** A saved view by its ID, or its name — exactly, then ignoring case. */
export function savedViewNamed(doc: FloorspecDocument | object, key: string): SavedView | undefined {
  const views = savedViewsOf(doc);
  const k = key.trim();
  return views.find((v) => v.id === k) ?? views.find((v) => v.name === k) ?? views.find((v) => v.name.toLowerCase() === k.toLowerCase()) ?? views.find((v) => v.id.toLowerCase() === k.toLowerCase());
}

/** The tangents of half the field of view a focal length gives a frame of this shape (width over height). */
export function lensTangents(focalLength: number, aspect: number): { tanX: number; tanY: number } {
  const long = FRAME_LONG_MM / 2 / Math.max(1, focalLength);
  return aspect >= 1 ? { tanX: long, tanY: long / aspect } : { tanX: long * aspect, tanY: long };
}

/** The field of view across the picture's long side, degrees: "24 mm · 74° across". */
export const fieldAcross = (focalLength: number): number => (2 * Math.atan(FRAME_LONG_MM / 2 / Math.max(1, focalLength)) * 180) / Math.PI;

/** The focal length whose long-side field of view is this, degrees: the inverse of `fieldAcross`. */
export const focalForField = (degrees: number): number => FRAME_LONG_MM / 2 / Math.tan((Math.max(1, Math.min(170, degrees)) * Math.PI) / 360);

/** The exposure a view's compensation multiplies a metered exposure by. */
export const exposureFactor = (tenths: number): number => 2 ** (tenths / 10);

type V3 = [number, number, number];

/**
 * What a camera is, in the document's frame and in metres (x east, y project north, z up): the
 * camera every view of a saved view is made from.
 */
export interface ViewCamera {
  /** Where it stands, metres. */
  readonly eye: V3;
  /** A point along its line of sight: the target, or under two-point perspective the target brought level with the eye. */
  readonly look: V3;
  /** The target itself, metres. */
  readonly target: V3;
  /** Vertical field of view of the picture, degrees. */
  readonly fovY: number;
  /** Width over height. */
  readonly aspect: number;
  /**
   * The lens shifted up (positive) or down, in half the picture's height: a point that projects to
   * `shift` before the shift is in the middle of the picture after it. Zero but under two-point perspective.
   */
  readonly shift: number;
  /** A thin lens (depth of field): its radius and the distance in focus along the line of sight, metres; null when everything is sharp. */
  readonly lens: { readonly radius: number; readonly focus: number } | null;
  /** Exposure compensation, as a factor on the metered exposure. */
  readonly exposure: number;
  readonly label: string;
}

const m = (u: number): number => u / UNITS_PER_METRE;

/**
 * The camera a saved view describes. `origin` (metres) is subtracted from every point — the editor's
 * mesh is built about one — and the default is none.
 */
export function viewCamera(view: SavedView, origin: readonly [number, number, number] = [0, 0, 0]): ViewCamera {
  const eye: V3 = [m(view.eye[0]) - origin[0], m(view.eye[1]) - origin[1], m(view.eye[2]) - origin[2]];
  const target: V3 = [m(view.target[0]) - origin[0], m(view.target[1]) - origin[1], m(view.target[2]) - origin[2]];
  const aspect = ASPECT_RATIOS[view.aspect];
  const { tanY } = lensTangents(view.focalLength, aspect);
  const flat = Math.hypot(target[0] - eye[0], target[1] - eye[1]);
  const rise = target[2] - eye[2];
  // Two-point: held level, the lens shifted so the target stays in the middle — unless it looks so far up or down that no shift would.
  const shifting = view.twoPoint && flat > 1e-6 && Math.abs(rise / flat) < SHIFT_MAX_SLOPE;
  const look: V3 = shifting ? [target[0], target[1], eye[2]] : target;
  const shift = shifting ? rise / flat / tanY : 0;
  const distance = Math.hypot(flat, rise);
  const lens =
    view.aperture === undefined
      ? null
      : {
          radius: view.focalLength / 1000 / fNumber(view.aperture) / 2,
          // Along the line of sight: the target's depth when no focus is given.
          focus: view.focus !== undefined ? m(view.focus) : shifting ? flat : distance,
        };
  return { eye, look, target, fovY: (2 * Math.atan(tanY) * 180) / Math.PI, aspect, shift, lens, exposure: exposureFactor(view.exposure), label: view.name };
}

/** A picture's size from its long side and a view's frame: `[width, height]`, pixels. */
export function pictureSize(long: number, aspect: Aspect): [number, number] {
  const r = ASPECT_RATIOS[aspect];
  return r >= 1 ? [long, Math.max(1, Math.round(long / r))] : [Math.max(1, Math.round(long * r)), long];
}

/** A view's camera in words, for a caption: "24 mm · 3:2 · two-point · f/8 · +0.3 EV". */
export function describeLens(view: Pick<SavedView, 'focalLength' | 'aspect' | 'twoPoint' | 'aperture' | 'exposure'>): string {
  const ev = view.exposure === 0 ? null : `${view.exposure > 0 ? '+' : '−'}${(Math.abs(view.exposure) / 10).toFixed(1)} EV`;
  return [`${String(view.focalLength)} mm`, view.aspect, view.twoPoint ? 'two-point' : null, view.aperture ?? null, ev].filter((x) => x !== null).join(' · ');
}

/** A point in metres (the document's frame, about `origin`) as FS_views records it: exact base units. */
export function toUnits(p: readonly [number, number, number], origin: readonly [number, number, number] = [0, 0, 0]): [number, number, number] {
  return [Math.round((p[0] + origin[0]) * UNITS_PER_METRE), Math.round((p[1] + origin[1]) * UNITS_PER_METRE), Math.round((p[2] + origin[2]) * UNITS_PER_METRE)];
}

/** The record FS_views keeps for a view: only what differs from its defaults. */
export function viewRecord(view: Omit<SavedView, 'id'>): Json {
  return {
    name: view.name,
    eye: [...view.eye],
    target: [...view.target],
    ...(view.focalLength === DEFAULT_FOCAL ? {} : { focalLength: view.focalLength }),
    ...(view.twoPoint ? { twoPoint: true } : {}),
    ...(view.aspect === '3:2' ? {} : { aspect: view.aspect }),
    ...(view.aperture === undefined ? {} : { aperture: view.aperture, ...(view.focus === undefined ? {} : { focus: view.focus }) }),
    ...(view.exposure === 0 ? {} : { exposure: view.exposure }),
    ...(view.level === undefined ? {} : { level: view.level, ...(view.levels === 'only' ? { levels: 'only' } : {}) }),
    ...(view.sky === 'clear' ? {} : { sky: view.sky }),
    ...(view.at === undefined ? {} : { at: view.at }),
    ...(view.scene !== undefined ? { scene: view.scene } : view.lights === 'on' ? { lights: 'on' } : {}),
  };
}

/** The next free view ID: SV1, SV2 …, none an ID the document already uses. */
export function nextViewId(taken: (id: string) => boolean): string {
  for (let i = 1; ; i++) if (!taken(`SV${String(i)}`)) return `SV${String(i)}`;
}
