/**
 * The upper level of a two-level layout (FLR-T-12.16): the same outline as the level below, the
 * stair's well cut where the stair rises, and the upper rooms either side of a hall the stair
 * arrives in.
 *
 * Laid out in the stair's frame (stair.ts), where it rises north:
 *
 *   ┌───────────────────────────────────────┐  DC
 *   │  north band: rooms, inner cells on the hall │
 *   ├───────────────────────────────────────┤  H + 4'
 *   │  hall — the stair arrives on its south edge │
 *   ├──────────────┬───────┬───────────────┤  H (the head)
 *   │ south-west   │ well  │ south-east    │
 *   │ rooms        ├───────┤ rooms         │  the first step the floor must be open over
 *   │              │closet │               │
 *   └──────────────┴───────┴───────────────┘  0
 *
 * The well runs from the head back to just before the first step the engine says needs the opening
 * (Core 17.6), so the steps below it keep the floor above them and the headroom is measured; its
 * open side is the hall's, so the stair arrives with the hall's 4' of floor before the next wall;
 * behind it, under the low steps, a closet. Each band's rooms are columns sized by area as the bands
 * of the lower level are (builders.ts), stretched to fill their band; a band the brief cannot fill
 * gets a bonus room, or closets where it is too shallow for a room.
 */
import { bandColumns, Extras, orderBand, placeBand, stretch, unitsOf, widthOf, type Column, type Placed, type Spec, type Unit } from './builders.js';
import { tiles, type Family, type Layout, type Rect, type Space } from './layout.js';
import { minDim, type Req } from './program.js';
import { canonDims, REACH, STAIR, toActualRect, type Frame, type Placement, type Profile } from './stair.js';
import { ftG, GRID } from './units.js';

/** The upper hall's depth: 4', as the lower level's halls are. */
const HALL = ftG(4);
/** The least width of a band a room can take; less is closets. */
const ROOM_MIN = ftG(8);
const CLOSET_MIN = ftG(2.5);
/** The depth below which a band of bedrooms costs more the shallower it is: 11'. */
const SLEEPING_DEPTH = ftG(11);

/** The upper level, keyed so its spaces never share a key with the lower level's. */
export interface Upper {
  /** Its spaces, in the footprint's own coordinates. */
  readonly layout: Layout;
  /** The hall the stair arrives in: its head room (Core 17.4). */
  readonly arrival: string;
  /** The well's key. */
  readonly well: string;
  /** The well, footprint coordinates, grid units. */
  readonly wellRect: Rect;
  /** Lower is better: floor the brief did not ask for, and rooms stretched past their size. */
  readonly cost: number;
  readonly notes: readonly string[];
}

const SW = 0;
const SE = 1;
const N = 2;

interface Group {
  /** Its x-range and y-range in the frame, grid units. */
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  /** Inner cells (the hall side) at the top of the band. */
  readonly innerTop: boolean;
  /** The order of a band, as builders.ts orders one: the primary bedroom at its far end. */
  readonly primaryFar: boolean;
}

/** The well's x-range in the frame, grid units: round the stair, clear of each wall's reach; or undefined. */
function wellX(xc: number, WC: number): [number, number] | undefined {
  const half = STAIR.width / 2;
  let x0 = Math.floor((xc - half - REACH.interior) / GRID);
  let x1 = Math.ceil((xc + half + REACH.interior) / GRID);
  // A sliver beside the well too narrow for a closet joins the well; an outside wall then bounds it.
  if (x0 < CLOSET_MIN) x0 = 0;
  if (WC - x1 < CLOSET_MIN) x1 = WC;
  if (x0 === 0 && xc - half < REACH.exterior) return undefined;
  if (x1 === WC && xc + half > WC * GRID - REACH.exterior) return undefined;
  return [x0, x1];
}

/** The geometry every assignment of rooms to bands shares, for one placement of the stair; undefined when there is no room for it. */
export interface Frame2 {
  readonly frame: Frame;
  readonly WC: number;
  readonly DC: number;
  readonly well: Rect;
  readonly groups: readonly (Group | undefined)[];
}

export function frameFor(p: Placement, W: number, D: number, profile: Profile): Frame2 | undefined {
  const frame: Frame = { dir: p.dir, W, D };
  const [WC, DC] = canonDims(frame);
  const wx = wellX(p.xc, WC);
  if (wx === undefined) return undefined;
  // The well's south edge: at or before the first step that needs the opening, clear of the wall there.
  const ys = Math.floor((p.foot + profile.first * STAIR.tread - REACH.interior) / GRID);
  if (ys < CLOSET_MIN || ys >= p.H) return undefined;
  const dn = DC - p.H - HALL;
  if (dn < 0 || (dn > 0 && dn < CLOSET_MIN)) return undefined;
  const groups: (Group | undefined)[] = [
    wx[0] > 0 ? { x0: 0, x1: wx[0], y0: 0, y1: p.H, innerTop: true, primaryFar: false } : undefined,
    wx[1] < WC ? { x0: wx[1], x1: WC, y0: 0, y1: p.H, innerTop: true, primaryFar: true } : undefined,
    dn > 0 ? { x0: 0, x1: WC, y0: p.H + HALL, y1: DC, innerTop: false, primaryFar: true } : undefined,
  ];
  return { frame, WC, DC, well: { x0: wx[0], y0: ys, x1: wx[1], y1: p.H }, groups };
}

/** A band's natural columns for some units: sized by area at the band's depth. */
interface Natural {
  readonly width: number;
  readonly sleeping: boolean;
}

const depthOf = (g: Group): number => g.y1 - g.y0;
const widthOfGroup = (g: Group): number => g.x1 - g.x0;

/** How a group is filled: its columns' natural width, stretched or padded with filler. */
function fillCost(g: Group | undefined, n: Natural | undefined): number | undefined {
  if (g === undefined) return n === undefined ? 0 : undefined;
  const t = widthOfGroup(g);
  const d = depthOf(g);
  if (n === undefined) return t * d * (d >= ROOM_MIN ? 0.8 : 1.2);
  if (n.sleeping && d < 18) return undefined;
  if (n.width > t) return undefined;
  // A band of bedrooms shallower than a bedroom is wide makes long, narrow rooms.
  const shallow = n.sleeping ? Math.max(0, SLEEPING_DEPTH - d) * t : 0;
  if (t <= n.width * 1.45) return (t - n.width) * d * 0.5 + shallow;
  const pad = t - Math.ceil(n.width * 1.15);
  return (t - pad - n.width) * d * 0.5 + pad * d * (d >= ROOM_MIN ? 0.8 : 1.2) + shallow;
}

/** Filler for a band left over: bonus rooms where it is deep enough for one, closets where not. */
function fillers(width: number, depth: number, extras: Extras, bonus: { n: number }): Spec[] | undefined {
  if (width < CLOSET_MIN) return undefined;
  if (depth >= ROOM_MIN && width >= ROOM_MIN) {
    const k = Math.max(1, Math.ceil(width / (3 * depth)));
    return Array.from({ length: k }, () => {
      bonus.n++;
      return { key: `up-bonus-${String(bonus.n)}`, name: bonus.n === 1 ? 'Bonus room' : `Bonus room ${String(bonus.n)}`, fn: 'unspecified', kind: 'room' as const };
    });
  }
  let k = Math.max(1, Math.ceil(width / ftG(4)));
  if (width / k < CLOSET_MIN) k = Math.floor(width / CLOSET_MIN);
  return Array.from({ length: k }, () => extras.closet());
}

/** Integer widths that add up to `total`, as even as they can be. */
const even = (total: number, k: number): number[] => Array.from({ length: k }, (_, i) => Math.floor(total / k) + (i < total % k ? 1 : 0));

/** The columns of a group: its units' natural columns, stretched, with filler at the end away from the stair. */
function groupColumns(g: Group, units: readonly Unit[], extras: Extras, bonus: { n: number }): Column[] | undefined {
  const t = widthOfGroup(g);
  const d = depthOf(g);
  const order = orderBand(units, g.primaryFar);
  const cols = units.length === 0 ? [] : bandColumns(order, d, extras);
  if (cols === undefined) return undefined;
  const n = widthOf(cols);
  if (n > t) return undefined;
  let pad = 0;
  if (cols.length === 0) pad = t;
  else if (t > n * 1.45) pad = t - Math.ceil(n * 1.15);
  if (!stretch(cols, t - pad, 1.45)) return undefined;
  if (pad === 0) return cols;
  const fill = fillers(pad, d, extras, bonus);
  if (fill === undefined) return undefined;
  const ws = even(pad, fill.length);
  const padded = fill.map((spec, i): Column => ({ width: ws[i]!, cells: [{ spec, size: d }] }));
  // Filler at the outer end of the band, away from the stair: west of the south-west band, east of the others.
  return g.primaryFar ? [...cols, ...padded] : [...padded, ...cols];
}

/** The most units the planner shares between the bands every way it can (3^n ways). */
const MAX_UNITS = 9;

/**
 * Lays out upper levels for the brief's upper rooms, one placement of the stair at a time. A
 * band's natural width depends only on its units, its depth and its order, so it is worked out once
 * for every placement.
 */
export class UpperPlanner {
  private readonly units: Unit[];
  private readonly natural = new Map<string, Natural>();
  constructor(reqs: readonly Req[]) {
    this.units = unitsOf(reqs);
  }

  /** Whether there are few enough units to share between the bands. */
  get feasible(): boolean {
    return this.units.length > 0 && this.units.length <= MAX_UNITS;
  }

  private naturalOf(g: Group, mask: number): Natural {
    const key = `${String(depthOf(g))}:${String(g.primaryFar)}:${String(mask)}`;
    const hit = this.natural.get(key);
    if (hit !== undefined) return hit;
    const us = this.units.filter((_, i) => (mask >> i) & 1);
    const cols = bandColumns(orderBand(us, g.primaryFar), depthOf(g), new Extras('probe-'));
    const v = cols === undefined ? { width: Infinity, sleeping: false } : { width: widthOf(cols), sleeping: us.some((u) => u.sleeping) };
    this.natural.set(key, v);
    return v;
  }

  /**
   * The upper level for one placement of the stair: every way of sharing the units between the
   * bands, cheapest first, built in full until `limit` of them tile.
   */
  build(p: Placement, f2: Frame2, family: Family, limit = 1): Upper[] {
    return buildUpper(p, f2, this.units, (g, mask) => this.naturalOf(g, mask), family, limit);
  }
}

function buildUpper(p: Placement, f2: Frame2, units: readonly Unit[], naturalOfGroup: (g: Group, mask: number) => Natural, family: Family, limit: number): Upper[] {
  const m = units.length;
  if (m === 0 || m > MAX_UNITS) return [];
  const naturalOf = (gi: number, mask: number): Natural | undefined => {
    const g = f2.groups[gi];
    return g === undefined || mask === 0 ? undefined : naturalOfGroup(g, mask);
  };
  const scored: { cost: number; masks: [number, number, number] }[] = [];
  const total = 3 ** m;
  for (let code = 0; code < total; code++) {
    const masks: [number, number, number] = [0, 0, 0];
    let c = code;
    for (let i = 0; i < m; i++) {
      masks[c % 3]! |= 1 << i;
      c = Math.floor(c / 3);
    }
    let cost = 0;
    let ok = true;
    for (const gi of [SW, SE, N]) {
      const g = f2.groups[gi];
      if (g === undefined && masks[gi] !== 0) {
        ok = false;
        break;
      }
      const n = masks[gi] === 0 ? undefined : naturalOf(gi, masks[gi]!);
      const fc = fillCost(g, n);
      if (fc === undefined || !Number.isFinite(fc)) {
        ok = false;
        break;
      }
      cost += fc;
    }
    if (ok) scored.push({ cost, masks });
  }
  scored.sort((a, b) => a.cost - b.cost || a.masks[0] - b.masks[0] || a.masks[1] - b.masks[1]);
  const out: Upper[] = [];
  for (const s of scored) {
    if (out.length >= limit) break;
    const u = assemble(p, f2, units, s.masks, family, s.cost);
    if (u !== undefined) out.push(u);
  }
  return out;
}

/** Where each band is, as a person reads the plan from the stair (the frame's compass is not the plan's). */
const GROUP_NAME = ['beside the stair', 'on its other side', 'across the hall'] as const;

function assemble(p: Placement, f2: Frame2, units: readonly Unit[], masks: readonly [number, number, number], family: Family, cost: number): Upper | undefined {
  const extras = new Extras('up-');
  const bonus = { n: 0 };
  const placed: Placed[] = [];
  for (const gi of [SW, SE, N]) {
    const g = f2.groups[gi];
    if (g === undefined) continue;
    const cols = groupColumns(
      g,
      units.filter((_, i) => (masks[gi]! >> i) & 1),
      extras,
      bonus,
    );
    if (cols === undefined) return undefined;
    placed.push(...placeBand(cols, g.x0, g.y0, g.y1, g.innerTop));
  }
  const hall = extras.hall('Upper hall');
  const w = f2.well;
  const wellSpec: Spec = { key: 'up-well', name: 'Stair well', fn: 'circulation', kind: 'well' };
  placed.push({ spec: hall, rect: { x0: 0, y0: p.H, x1: f2.WC, y1: p.H + HALL } });
  placed.push({ spec: wellSpec, rect: w });
  placed.push({ spec: extras.closet(), rect: { x0: w.x0, y0: 0, x1: w.x1, y1: w.y0 } });
  const spaces: Space[] = placed.map((x) => ({
    key: x.spec.key,
    name: x.spec.name,
    fn: x.spec.fn,
    kind: x.spec.kind,
    ...(x.spec.req === undefined ? {} : { req: x.spec.req }),
    rect: toActualRect(f2.frame, x.rect),
  }));
  const layout: Layout = {
    family,
    variant: 'upper',
    structure: 'upper',
    label: 'Upper floor along a hall the stair arrives in',
    width: f2.frame.W,
    depth: f2.frame.D,
    spaces,
    openPlan: false,
    notes: [],
  };
  if (!upperSane(layout)) return undefined;
  const notes: string[] = [];
  for (const gi of [SW, SE, N]) {
    const us = units.filter((_, i) => (masks[gi]! >> i) & 1);
    if (us.length > 0) notes.push(`${GROUP_NAME[gi]}: ${us.flatMap((u) => u.reqs.map((r) => r.name)).join(', ')}`);
  }
  if (bonus.n > 0) notes.push(`${String(bonus.n)} bonus room${bonus.n === 1 ? '' : 's'} where the brief leaves the upper floor's outline unfilled`);
  return { layout, arrival: hall.key, well: wellSpec.key, wellRect: toActualRect(f2.frame, w), cost, notes };
}

/** Every space at least its least dimension, rooms no more than 3.5 : 1, and the spaces tiling the outline. */
function upperSane(layout: Layout): boolean {
  if (!tiles(layout)) return false;
  for (const s of layout.spaces) {
    const w = s.rect.x1 - s.rect.x0;
    const h = s.rect.y1 - s.rect.y0;
    const least = s.kind === 'closet' ? CLOSET_MIN : s.kind === 'hall' || s.kind === 'well' ? 7 : Math.min(minDim(s.fn), 18);
    if (Math.min(w, h) < least) return false;
    if (s.kind === 'room' && Math.max(w, h) / Math.min(w, h) > 3.5) return false;
  }
  return true;
}
