/**
 * A virtual tour (FLR-T-14.2): a 360° panorama from every room, linked at the doorways, shared as one
 * link. What the worker that renders it, the api that queues it and the viewer that walks it agree
 * on: the sizes and qualities a tour is made at (within a still's work budget per panorama), the
 * eye height, the rooms toured unless a person says otherwise, the one light every panorama is seen
 * in, the equirectangular projection, and the manifest the viewer reads.
 *
 * Directions are in the project's frame (x east, y project north, z up): a yaw is degrees clockwise
 * from project north, a pitch degrees above the horizon. An equirectangular panorama's middle column
 * looks north (yaw 0), its left edge south by the west (yaw −180°), its top row straight up — so every
 * panorama of a tour is turned the same way, and a heading carries from one room into the next.
 */

/** A panorama's width, pixels; its height is half of it. Rendered as six cube faces a quarter of the width across. */
export const TOUR_SIZES = { small: 1024, medium: 2048, large: 4096 } as const;
export type TourSize = keyof typeof TOUR_SIZES;
/** Samples a pixel of each cube face. */
export const TOUR_QUALITIES = { draft: 8, standard: 16, high: 32 } as const;
export type TourQuality = keyof typeof TOUR_QUALITIES;
/** A still's work budget (apps/worker pathtrace/presets.ts `MAX_WORK`): what one panorama may take. */
export const TOUR_MAX_WORK = 1024 * 768 * 256;
/** The most rooms one tour renders. */
export const MAX_TOUR_ROOMS = 24;

/** The side of a panorama's cube faces, pixels. */
export const tourFace = (size: TourSize): number => TOUR_SIZES[size] / 4;

/** Whether a panorama of this size and quality is within a still's work budget: six faces, each its samples. */
export function tourWithinBudget(size: TourSize, quality: TourQuality): boolean {
  const face = tourFace(size);
  return 6 * face * face * TOUR_QUALITIES[quality] <= TOUR_MAX_WORK;
}

/** Base units an inch (FLR-ADR-004: 1/1280 mm). */
const INCH = 32_512;
/** Where the eye is above the floor, base units: 5'-3", a standing adult's. */
export const DEFAULT_EYE_HEIGHT = 63 * INCH;
export const MIN_EYE_HEIGHT = 36 * INCH;
export const MAX_EYE_HEIGHT = 84 * INCH;

/** The light every panorama is seen in: a clear sky at three in the afternoon on midsummer's day, at the site. */
export const TOUR_SKY = 'clear';
export const tourAt = (year: number): string => `${String(year)}-06-21T15:00`;

/** Room functions a tour leaves out unless asked: a garage, a store or closet, and the outdoors. */
const LEFT_OUT = new Set(['garage', 'storage', 'exterior']);

/** Whether a room is toured unless a person says otherwise: not a garage, a closet or outside. */
export function touredByDefault(room: { readonly function?: string; readonly name?: string }): boolean {
  if (room.function !== undefined && LEFT_OUT.has(room.function)) return false;
  return !/\b(closet|garage|wic)\b/i.test(room.name ?? '');
}

type Rooms = { readonly rooms?: Readonly<Record<string, { readonly level: string; readonly function?: string; readonly name?: string } | undefined>> };
type Levels = { readonly levels?: Readonly<Record<string, { readonly elevation?: number } | undefined>> };

/**
 * The rooms a tour visits when none are named, in its order: every room but garages, closets and the
 * outdoors, the lowest level first; on each level the entry (a room named entry or foyer) first —
 * the tour opens there — then by ID.
 */
export function tourRoomsByDefault(doc: Rooms & Levels): string[] {
  const levels = Object.entries(doc.levels ?? {})
    .flatMap(([id, l]) => (l === undefined ? [] : [{ id, elevation: l.elevation ?? 0 }]))
    .sort((x, y) => x.elevation - y.elevation || (x.id < y.id ? -1 : 1));
  const order = new Map(levels.map((l, i) => [l.id, i]));
  const entry = (name: string | undefined) => (/\b(entry|foyer)\b/i.test(name ?? '') ? 0 : 1);
  return Object.entries(doc.rooms ?? {})
    .flatMap(([id, r]) => (r === undefined ? [] : [[id, r] as const]))
    .filter(([, r]) => touredByDefault({ ...(r.function === undefined ? {} : { function: r.function }), ...(r.name === undefined ? {} : { name: r.name }) }))
    .sort(([a, x], [b, y]) => (order.get(x.level) ?? 0) - (order.get(y.level) ?? 0) || entry(x.name) - entry(y.name) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}

// ─── The projection ─────────────────────────────────────────────────────────────────────────

export type Point3 = readonly [number, number, number];

/** A direction: yaw degrees clockwise from project north, pitch degrees above the horizon. */
export interface YawPitch {
  readonly yaw: number;
  readonly pitch: number;
}

const DEG = Math.PI / 180;

/** A yaw brought into (−180°, 180°]. */
export function wrapYaw(yaw: number): number {
  const y = ((((yaw + 180) % 360) + 360) % 360) - 180;
  return y === -180 ? 180 : y;
}

/** The direction from one point to another (project frame, any unit). */
export function yawPitch(from: Point3, to: Point3): YawPitch {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const flat = Math.hypot(dx, dy);
  return { yaw: flat === 0 ? 0 : wrapYaw(Math.atan2(dx, dy) / DEG), pitch: Math.atan2(dz, flat) / DEG };
}

/** The unit vector of a direction, in the project's frame. */
export function directionOf(d: YawPitch): [number, number, number] {
  const c = Math.cos(d.pitch * DEG);
  return [Math.sin(d.yaw * DEG) * c, Math.cos(d.yaw * DEG) * c, Math.sin(d.pitch * DEG)];
}

/** Where a direction falls on an equirectangular panorama: u across (0 at yaw −180°), v down (0 straight up). */
export function equirectUv(d: YawPitch): [number, number] {
  const u = (wrapYaw(d.yaw) + 180) / 360;
  return [u >= 1 ? 0 : u, 0.5 - d.pitch / 180];
}

/** The direction a point of an equirectangular panorama looks along. */
export function equirectYawPitch(u: number, v: number): YawPitch {
  return { yaw: wrapYaw(u * 360 - 180), pitch: (0.5 - v) * 180 };
}

// ─── The manifest ───────────────────────────────────────────────────────────────────────────

/** A plan drawn for the tour's map: SVG pixels from metres, `X = x0 + s·x`, `Y = y0 − s·y`. */
export interface TourPlanFrame {
  readonly x0: number;
  readonly y0: number;
  readonly s: number;
}

export interface TourLevel {
  readonly id: string;
  readonly name: string;
  /** The level's plan in each theme: files of the tour, and their size in SVG pixels. */
  readonly plan: { readonly light: string; readonly dark: string; readonly width: number; readonly height: number; readonly frame: TourPlanFrame };
}

/** A doorway to another toured room, as the panorama sees it. */
export interface TourHotspot {
  /** The room it leads to, by ID. */
  readonly to: string;
  /** That room's name. */
  readonly label: string;
  /** The door, opening or separator, by ID. */
  readonly via: string;
  readonly kind: 'door' | 'opening' | 'separator';
  /** Toward the doorway's threshold, from the eye. */
  readonly yaw: number;
  readonly pitch: number;
  /** The threshold's middle, metres. */
  readonly at: Point3;
}

export interface TourRoom {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  /** The panorama: a file of the tour (an equirectangular JPEG). */
  readonly pano: string;
  /** Where the eye is, metres (project frame). */
  readonly eye: Point3;
  /** Which way the room is first looked at: a saved view's line of sight, or toward its first doorway. */
  readonly heading: number;
  /** Where it stands: the room's visual centre, or a saved view's eye (by name). */
  readonly stands: { readonly at: 'centre' } | { readonly at: 'view'; readonly view: string };
  readonly hotspots: readonly TourHotspot[];
}

export interface TourManifest {
  readonly tour: 1;
  readonly project: string;
  readonly version: { readonly hash: string; readonly seq: number | null };
  /** The room the tour opens in. */
  readonly start: string;
  readonly width: number;
  readonly height: number;
  readonly quality: TourQuality;
  readonly samples: number;
  /** Base units above each room's floor. */
  readonly eyeHeight: number;
  readonly light: { readonly sky: string; readonly at: string };
  readonly levels: readonly TourLevel[];
  readonly rooms: readonly TourRoom[];
}

/** Doorways linked: each pair of toured rooms a hotspot joins, counted once. */
export function linkedDoorways(manifest: Pick<TourManifest, 'rooms'>): number {
  const pairs = new Set<string>();
  for (const r of manifest.rooms) for (const h of r.hotspots) pairs.add(r.id < h.to ? `${r.id}|${h.to}` : `${h.to}|${r.id}`);
  return pairs.size;
}
