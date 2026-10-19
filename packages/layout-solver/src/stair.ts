/**
 * The stair of a two-level layout (FLR-T-12.16): what it is, where on the lower level it can stand,
 * and the frames that let one upper-level builder serve all four directions it can rise in.
 *
 * The stair is straight, 3' wide, with 10" treads, risers of at most 7 3/4" and 6' 8" of headroom
 * declared — the usual US residential numbers (IRC R311.7), advisory like everything the solver
 * makes. How many risers it has, and which of its steps the floor above must be open over, are the
 * engine's to say (Core 17.4, 17.6): `profileOf` asks it once, of a probe that is the document with
 * one plain room below and the stair in it, and the solver plans with that.
 *
 * On the lower level the stair stands in a room people pass through anyway — an entry, a living or
 * a dining room — along one of its sides, clear of the walls by their half thickness, with 3' of the
 * room's floor before its foot and every door and cased opening of the room clear of it.
 */
import { check } from '@floorspec/engine';
import { apply, type Operation } from '@floorspec/ops';
import { openingSpans, type Access } from './access.js';
import type { Json } from './document.js';
import { Ids } from './emit.js';
import { isExterior, type Rect, type Seg, type Space, type Layout } from './layout.js';
import { BU_PER_FOOT, GRID, inBu } from './units.js';

/** The stair the solver places, in base units. */
export const STAIR = {
  width: inBu(36),
  tread: inBu(10),
  maxRiser: inBu(7.75),
  minHeadroom: inBu(80),
} as const;

/** The least clear floor at a stair's foot and at its head: 3'. */
export const LANDING_CLEAR = inBu(36);

/** How far each kind of edge's wall reaches from its grid line into a room: an exterior wall is drawn inward from its exterior face. */
export const REACH = { exterior: inBu(7.25), interior: inBu(2.25), separator: 0 } as const;

/** The way a stair rises, as a compass direction (the front of the house is south). */
export type Dir = 'N' | 'S' | 'E' | 'W';
export const DIRS: readonly Dir[] = ['N', 'S', 'E', 'W'];

/** Core 17.1: a stair's rotation, the direction its first flight rises in, counter-clockwise from +X, in microdegrees. */
export const ROTATION: Readonly<Record<Dir, number>> = { N: 90_000_000, S: -90_000_000, E: 0, W: 180_000_000 };

const DIR_NAME: Readonly<Record<Dir, string>> = { N: 'north', S: 'south', E: 'east', W: 'west' };
export const dirName = (d: Dir): string => DIR_NAME[d];

/**
 * A frame in which the stair rises north (+y). Its canonical width and depth are the footprint's,
 * swapped for a stair that rises east or west. Every map here is a reflection or a rotation of the
 * footprint onto itself, so rectangles stay rectangles and the grid stays the grid.
 */
export interface Frame {
  readonly dir: Dir;
  /** The footprint as it is, in grid units. */
  readonly W: number;
  readonly D: number;
}

/** The canonical width and depth of a frame. */
export const canonDims = (f: Frame): [number, number] => (f.dir === 'N' || f.dir === 'S' ? [f.W, f.D] : [f.D, f.W]);

/** A canonical point to the footprint's own coordinates; `scale` is GRID for base units, 1 for grid units. */
export function toActual(f: Frame, x: number, y: number, scale = 1): [number, number] {
  const W = f.W * scale;
  const D = f.D * scale;
  switch (f.dir) {
    case 'N':
      return [x, y];
    case 'S':
      return [x, D - y];
    case 'E':
      return [y, x];
    case 'W':
      return [W - y, x];
  }
}

/** A point of the footprint to the frame's canonical coordinates. */
export function toCanon(f: Frame, X: number, Y: number, scale = 1): [number, number] {
  const W = f.W * scale;
  const D = f.D * scale;
  switch (f.dir) {
    case 'N':
      return [X, Y];
    case 'S':
      return [X, D - Y];
    case 'E':
      return [Y, X];
    case 'W':
      return [Y, W - X];
  }
}

const rectVia = (map: (x: number, y: number) => [number, number], r: Rect): Rect => {
  const [ax, ay] = map(r.x0, r.y0);
  const [bx, by] = map(r.x1, r.y1);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
};
export const toActualRect = (f: Frame, r: Rect): Rect => rectVia((x, y) => toActual(f, x, y), r);
export const toCanonRect = (f: Frame, r: Rect): Rect => rectVia((x, y) => toCanon(f, x, y), r);

/** What the engine says of the stair between two levels, from the probe. */
export interface Profile {
  /** Core 17.4: its riser count. */
  readonly risers: number;
  /** Core 17.6: the index of the first step the floor above must be open over. */
  readonly first: number;
  /** Foot to head along the run, base units: (risers − 1) treads. */
  readonly run: number;
  /** Core 17.4: its riser height, rounded. */
  readonly riserHeight: number;
}

/**
 * Ask the engine how the stair rises between `lo` and `hi`: the document as the solver lays it out
 * (a Core 0.4 document: `minHeadroom` is a 0.4 member), with one 40' room on `lo` — walls of the
 * kind the solver draws, a ceiling as its rooms have — and the stair in it, rising north.
 * Undefined when that does not commit or derive.
 */
export function profileOf(working: Json, lo: string, hi: string, used: ReadonlySet<string>, upgrade: readonly Operation[]): Profile | undefined {
  const ids = new Ids(used);
  const t = ids.mint('T');
  const side = 40 * BU_PER_FOOT;
  const corners: [number, number][] = [
    [0, 0],
    [0, side],
    [side, side],
    [side, 0],
  ];
  const st = ids.mint('ST');
  const batch: Operation[] = [
    ...upgrade,
    { op: 'addElement', collection: 'types', id: t, element: { kind: 'wallType', name: 'Probe wall', layers: [{ thickness: inBu(4.5), function: 'core' }] } },
    // Clockwise, located on the exterior face, as the solver draws its outside walls.
    ...corners.map((p, i): Operation => ({ op: 'drawWall', level: lo, from: p, to: corners[(i + 1) % 4]!, type: t, justification: 'exteriorFace' })),
    { op: 'addRoom', id: ids.mint('R'), level: lo, at: [side / 2, side / 2], name: 'Probe', function: 'living' },
    { op: 'addElement', collection: 'stairs', id: st, element: stairElement(lo, hi, [side / 2, 5 * BU_PER_FOOT], 'N') },
  ];
  const r = apply(working, { batch });
  if (r.status !== 'committed') return undefined;
  const c = check(JSON.parse(r.document) as Json);
  const d = c.derived?.stairs?.[st];
  if (!c.valid || d === undefined) return undefined;
  const steps = d.steps?.length ?? d.risers - 1;
  return { risers: d.risers, first: d.opening?.first ?? Math.max(0, steps - 1), run: (d.risers - 1) * STAIR.tread, riserHeight: d.riserHeight };
}

/** The stair as an element of `stairs` (Core 17.1): its foot at `position`, rising `dir`. */
export function stairElement(level: string, to: string, position: readonly [number, number], dir: Dir): Record<string, unknown> {
  return {
    level,
    to,
    position: [position[0], position[1]],
    rotation: ROTATION[dir],
    width: STAIR.width,
    tread: STAIR.tread,
    maxRiser: STAIR.maxRiser,
    minHeadroom: STAIR.minHeadroom,
    name: 'Stair',
  };
}

/** Rooms a stair may stand in, best first: rooms people pass through anyway. */
const HOSTS: Readonly<Record<string, number>> = { circulation: 0, living: 1, dining: 2 };

/** Where the stair stands, in the frame of its direction. */
export interface Placement {
  readonly dir: Dir;
  /** The lower level's room it stands in. */
  readonly host: string;
  /** The stair's centre line, canonical x, base units. */
  readonly xc: number;
  /** The head's line, canonical y, grid units: where the upper floor's edge is. */
  readonly H: number;
  /** Its foot, canonical y, base units. */
  readonly foot: number;
  /** Whether it stands against an outside wall. */
  readonly outside: boolean;
  /** Lower is better: the kind of room it stands in, and an outside wall it would stand against. */
  readonly cost: number;
}

/** A segment in base units, canonical. */
interface CSeg {
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  readonly horizontal: boolean;
}

/**
 * Every place the stair can stand on a lower level: in each host room, rising in each direction,
 * along either side of the room (as the stair rises), at every head line on the grid that leaves
 * 3' before its foot inside the room. None where a door or a cased opening of the room is within 3'
 * of it, or where it would leave less than 3' of an open side to a neighbouring room.
 */
export function placements(layout: Layout, segs: readonly Seg[], access: Access, profile: Profile): Placement[] {
  const out: Placement[] = [];
  const half = STAIR.width / 2;
  // Every door, cased opening, front door and garage door, where along its segment it goes.
  const spans = openingSpans(access);
  for (const host of layout.spaces) {
    const rank = HOSTS[host.fn];
    if (host.kind !== 'room' || rank === undefined) continue;
    const mine = segs.filter((s) => s.left === host.key || s.right === host.key);
    for (const dir of DIRS) {
      const f: Frame = { dir, W: layout.width, D: layout.depth };
      const R = toCanonRect(f, host.rect);
      const G = GRID;
      const canon = (a: readonly [number, number], b: readonly [number, number]): CSeg => {
        const [ax, ay] = toCanon(f, a[0], a[1], G);
        const [bx, by] = toCanon(f, b[0], b[1], G);
        return { a: [Math.min(ax, bx), Math.min(ay, by)], b: [Math.max(ax, bx), Math.max(ay, by)], horizontal: ay === by };
      };
      const cs = mine.map((s) => ({ seg: canon([s.a[0] * G, s.a[1] * G], [s.b[0] * G, s.b[1] * G]), src: s }));
      // The openings in the room's sides, as canonical segments of their own width.
      const holes = spans
        .filter((o) => mine.includes(o.seg))
        .map((o) => {
          const along = (t: number): [number, number] => (o.seg.horizontal ? [o.seg.a[0] * G + t, o.seg.a[1] * G] : [o.seg.a[0] * G, o.seg.a[1] * G + t]);
          return canon(along(o.start), along(o.end));
        });
      const reachOf = (s: Seg): number => (isExterior(s) ? REACH.exterior : access.separators.has(s) ? REACH.separator : REACH.interior);
      const sideReach = (pick: (c: CSeg) => boolean): { reach: number; outside: boolean } => {
        let reach = 0;
        let outside = false;
        for (const { seg, src } of cs)
          if (pick(seg)) {
            reach = Math.max(reach, reachOf(src));
            outside ||= isExterior(src);
          }
        return { reach, outside };
      };
      const west = sideReach((c) => !c.horizontal && c.a[0] === R.x0 * G);
      const east = sideReach((c) => !c.horizontal && c.a[0] === R.x1 * G);
      const south = sideReach((c) => c.horizontal && c.a[1] === R.y0 * G);
      const north = sideReach((c) => c.horizontal && c.a[1] === R.y1 * G);
      // Clear of a wall by its reach and a little more: 6" from a partition's line, 9" from an outside wall's face line.
      const offset = (s: { reach: number }): number => (s.reach === REACH.exterior ? inBu(9) : inBu(6));
      const Hmax = Math.floor((R.y1 * G - north.reach) / G);
      const Hmin = Math.ceil((R.y0 * G + south.reach + LANDING_CLEAR + profile.run) / G);
      for (const side of ['west', 'east'] as const) {
        const xc = side === 'west' ? R.x0 * G + offset(west) + half : R.x1 * G - offset(east) - half;
        if (xc - half < R.x0 * G + west.reach || xc + half > R.x1 * G - east.reach) continue;
        const outside = side === 'west' ? west.outside : east.outside;
        for (let H = Hmin; H <= Hmax; H++) {
          const foot = H * G - profile.run;
          // The stair and the floor before its foot.
          const zone = { x0: xc - half, x1: xc + half, y0: foot - LANDING_CLEAR, y1: H * G };
          if (!clearOfOpenings(cs, holes, access, zone)) continue;
          out.push({ dir, host: host.key, xc, H, foot, outside, cost: rank * 10 + (outside ? 6 : 0) });
        }
      }
    }
  }
  return out;
}

/** The part of a side's span [a, b] that a zone shadows: within 3' of the side, across from it. */
function shadowed(seg: CSeg, zone: { x0: number; x1: number; y0: number; y1: number }): number {
  const [lo, hi, d] = seg.horizontal
    ? [Math.max(seg.a[0], zone.x0), Math.min(seg.b[0], zone.x1), Math.min(Math.abs(zone.y0 - seg.a[1]), Math.abs(zone.y1 - seg.a[1]))]
    : [Math.max(seg.a[1], zone.y0), Math.min(seg.b[1], zone.y1), Math.min(Math.abs(zone.x0 - seg.a[0]), Math.abs(zone.x1 - seg.a[0]))];
  const inside = seg.horizontal ? seg.a[1] >= zone.y0 && seg.a[1] <= zone.y1 : seg.a[0] >= zone.x0 && seg.a[0] <= zone.x1;
  if (hi <= lo) return 0;
  return inside || d < LANDING_CLEAR ? hi - lo : 0;
}

/** No door or cased opening of the room within 3' of the zone, and 3' left of every open side it shares with a neighbour. */
function clearOfOpenings(cs: readonly { seg: CSeg; src: Seg }[], holes: readonly CSeg[], access: Access, zone: { x0: number; x1: number; y0: number; y1: number }): boolean {
  for (const h of holes) if (shadowed(h, zone) > 0) return false;
  const open = new Map<string, { total: number; blocked: number }>();
  for (const { seg, src } of cs) {
    const s = shadowed(seg, zone);
    if (access.separators.has(src)) {
      const other = `${src.left ?? ''}|${src.right ?? ''}`;
      const o = open.get(other) ?? { total: 0, blocked: 0 };
      const len = seg.horizontal ? seg.b[0] - seg.a[0] : seg.b[1] - seg.a[1];
      o.total += len;
      o.blocked += s;
      open.set(other, o);
    }
  }
  for (const o of open.values()) if (o.total - o.blocked < LANDING_CLEAR) return false;
  return true;
}

/** The host's name and how the stair stands in it, for explanations. */
export function describePlacement(p: Placement, host: Space): string {
  return `a straight stair rises ${dirName(p.dir)} along a side of the ${host.name}${p.outside ? ', against an outside wall' : ''}`;
}
