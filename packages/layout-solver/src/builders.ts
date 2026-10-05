/**
 * Layout strategies. Each turns the brief's room requests into rectangles that tile a rectangular
 * footprint (a slicing floorplan), in grid units, with the front of the house to the south:
 *
 * - **wing** — the public rooms (living, dining, kitchen, entry) at the west, a bedroom wing to the
 *   east along a hall with rooms on both sides; optionally the primary suite across the hall's end.
 * - **split** — the primary suite on the far side of the public rooms from the other bedrooms.
 * - **compact** — no hall: a column of private rooms opening straight off the living spaces, for
 *   small programs (cabins, studios).
 *
 * Within a band of rooms each room is as deep as the band and as wide as its area needs, never
 * narrower than its function's least dimension; two small rooms may share a column (a bath with a
 * linen closet behind it, a bath and a walk-in closet en suite), and a small room left with spare
 * depth gets a closet behind it. The access planner (access.ts) then decides the doors.
 */
import type { Family, Layout, Rect, Space, SpaceKind } from './layout.js';
import { affinity, grossG, minDim, type Adjacency, type Req } from './program.js';
import { ftG } from './units.js';

/** Hall width, centreline to centreline: 4 ft leaves 3' 7 1/2" clear between 2x4 partitions. */
export const HALL = ftG(4);
/** The least depth of a closet the solver adds behind a small room. */
const CLOSET_MIN = ftG(2.5);

interface Spec {
  readonly key: string;
  readonly name: string;
  readonly fn: string;
  readonly kind: SpaceKind;
  readonly req?: Req;
}

interface Cell {
  readonly spec: Spec;
  size: number;
}

/** A column of a band: its width, and its cells from the band's inner edge (the hall side) outwards. */
interface Column {
  width: number;
  readonly cells: Cell[];
}

const specOf = (r: Req): Spec => ({ key: r.key, name: r.name, fn: r.fn, kind: 'room', req: r });

/** Mints the solver's own closets and halls with stable keys. */
export class Extras {
  private closets = 0;
  private halls = 0;
  closet(): Spec {
    this.closets++;
    return { key: `closet-${String(this.closets)}`, name: this.closets === 1 ? 'Closet' : `Closet ${String(this.closets)}`, fn: 'storage', kind: 'closet' };
  }
  hall(): Spec {
    this.halls++;
    return { key: `hall-${String(this.halls)}`, name: this.halls === 1 ? 'Hall' : `Hall ${String(this.halls)}`, fn: 'circulation', kind: 'hall' };
  }
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

/** Integers proportional to `weights` that add up to `total` (largest remainder, ties by index). */
export function apportion(weights: readonly number[], total: number): number[] {
  const w = sum(weights);
  if (weights.length === 0) return [];
  if (w <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((x) => (x / w) * total);
  const out = exact.map((x) => Math.floor(x));
  let left = total - sum(out);
  const order = exact.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((p, q) => q.f - p.f || p.i - q.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]!.i]!++;
  return out;
}

/** Sizes that add up to `total`, each at least its minimum, the rest shared by weight. Undefined when the minima do not fit. */
export function fitSizes(weights: readonly number[], mins: readonly number[], total: number): number[] | undefined {
  if (sum(mins) > total) return undefined;
  const out = [...mins];
  // Grow each size towards its share of the total, then give out what is left by weight.
  const share = apportion(weights, total);
  let left = total - sum(out);
  const want = share.map((s, i) => Math.max(0, s - out[i]!));
  const give = apportion(want, Math.min(left, sum(want)));
  give.forEach((g, i) => (out[i]! += g));
  left = total - sum(out);
  if (left > 0) apportion(weights, left).forEach((g, i) => (out[i]! += g));
  return out;
}

const isSmallFn = (fn: string): boolean => fn === 'bath' || fn === 'laundry' || fn === 'utility' || fn === 'storage' || fn === 'mechanical';

/** Whether two consecutive requests may share a column, one behind the other. */
function canStack(r: Req, s: Req, depth: number): boolean {
  if (r.host !== undefined && r.host === s.host) return true;
  if (r.host !== undefined || s.host !== undefined) return false;
  if (!isSmallFn(r.fn) || !isSmallFn(s.fn)) return false;
  return grossG(r) < depth * minDim(r.fn) && grossG(s) < depth * minDim(s.fn);
}

/** Needs a door of its own onto the hall (or the middle): it goes on the inner side of a stack. */
const needsAccess = (r: Req): number => (r.host !== undefined ? 0 : r.fn === 'storage' || r.fn === 'mechanical' ? 1 : 2);

/** The columns of a band of `depth`, rooms in order from west to east. */
function bandColumns(order: readonly Req[], depth: number, extras: Extras): Column[] | undefined {
  const cols: Column[] = [];
  for (let i = 0; i < order.length; i++) {
    const r = order[i]!;
    const s = order[i + 1];
    const A = grossG(r);
    const m = minDim(r.fn);
    if (s !== undefined && canStack(r, s, depth)) {
      const [inner, outer] = needsAccess(s) > needsAccess(r) ? [s, r] : [r, s];
      const mi = minDim(inner.fn);
      const mo = minDim(outer.fn);
      const w = Math.max(mi, mo, Math.ceil((grossG(inner) + grossG(outer)) / depth));
      const sizes = fitSizes([grossG(inner), grossG(outer)], [mi, mo], depth);
      if (sizes !== undefined) {
        cols.push({ width: w, cells: [{ spec: specOf(inner), size: sizes[0]! }, { spec: specOf(outer), size: sizes[1]! }] });
        i++;
        continue;
      }
    }
    if (depth < Math.min(m, ftG(7))) return undefined;
    const w = Math.ceil(A / depth);
    if (w >= m) {
      cols.push({ width: w, cells: [{ spec: specOf(r), size: depth }] });
      continue;
    }
    // Narrow: at its least width, how deep must it be? Spare depth behind it becomes a closet.
    const h = Math.max(m, Math.ceil(A / m));
    if (r.fn !== 'sleeping' && depth - h >= CLOSET_MIN) {
      cols.push({ width: m, cells: [{ spec: specOf(r), size: h }, { spec: extras.closet(), size: depth - h }] });
      continue;
    }
    cols.push({ width: m, cells: [{ spec: specOf(r), size: depth }] });
  }
  return cols;
}

const widthOf = (cols: readonly Column[]): number => sum(cols.map((c) => c.width));

/** Widen a band's columns to `width`, in proportion to their widths. Undefined if that stretches them too far. */
function stretch(cols: Column[], width: number, limit: number): boolean {
  const have = widthOf(cols);
  if (have === width) return true;
  if (have > width || cols.length === 0) return cols.length === 0 && width === 0;
  if (width / have > limit) return false;
  const extra = apportion(
    cols.map((c) => c.width),
    width - have,
  );
  cols.forEach((c, i) => (c.width += extra[i]!));
  return true;
}

interface Placed {
  readonly spec: Spec;
  readonly rect: Rect;
}

/** Place a band's columns from x0, filling [y0, y1]; inner cells at the top when innerTop. */
function placeBand(cols: readonly Column[], x0: number, y0: number, y1: number, innerTop: boolean): Placed[] {
  const out: Placed[] = [];
  let x = x0;
  for (const c of cols) {
    let edge = innerTop ? y1 : y0;
    for (const cell of c.cells) {
      const rect = innerTop ? { x0: x, y0: edge - cell.size, x1: x + c.width, y1: edge } : { x0: x, y0: edge, x1: x + c.width, y1: edge + cell.size };
      out.push({ spec: cell.spec, rect });
      edge = innerTop ? edge - cell.size : edge + cell.size;
    }
    x += c.width;
  }
  return out;
}

const shift = (ps: readonly Placed[], dx: number): Placed[] => ps.map((p) => ({ spec: p.spec, rect: { x0: p.rect.x0 + dx, y0: p.rect.y0, x1: p.rect.x1 + dx, y1: p.rect.y1 } }));

// ── grouping and ordering ──────────────────────────────────────────────────────

/** A bedroom with its en-suite rooms, or a single room. */
export interface Unit {
  readonly reqs: readonly Req[];
  readonly sleeping: boolean;
  readonly area: number;
}

const byKey = (a: Req, b: Req): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Group private requests into units: each bedroom with its en-suite rooms (bath first), and singles. */
export function unitsOf(reqs: readonly Req[]): Unit[] {
  const hosts = new Set(reqs.filter((r) => r.fn === 'sleeping').map((r) => r.key));
  const units: Unit[] = [];
  for (const r of [...reqs].sort((a, b) => b.target - a.target || byKey(a, b))) {
    if (r.host !== undefined && hosts.has(r.host)) continue;
    if (r.fn === 'sleeping') {
      const suite = reqs.filter((x) => x.host === r.key).sort((a, b) => Number(a.fn !== 'bath') - Number(b.fn !== 'bath') || byKey(a, b));
      units.push({ reqs: [r, ...suite], sleeping: true, area: sum([r, ...suite].map(grossG)) });
    } else units.push({ reqs: [r], sleeping: false, area: grossG(r) });
  }
  return units;
}

/**
 * The west-to-east order of a band: bedrooms with something smaller between them, so baths sit
 * between bedrooms; the largest bedroom at the far (east) end when `primaryFar`, its en-suite rooms
 * on the side towards the rest; leftover small rooms at the west end, nearest the living spaces.
 */
function orderBand(units: readonly Unit[], primaryFar: boolean): Req[] {
  const beds = units.filter((u) => u.sleeping).sort((a, b) => (primaryFar ? a.area - b.area : b.area - a.area) || byKey(a.reqs[0]!, b.reqs[0]!));
  const singles = units.filter((u) => !u.sleeping).sort((a, b) => b.area - a.area || byKey(a.reqs[0]!, b.reqs[0]!));
  const seq: Req[] = [];
  beds.forEach((u, i) => {
    const [host, ...suite] = u.reqs;
    const far = primaryFar ? i === beds.length - 1 : i === 0;
    // The host takes the outer corner at the band's ends; its suite faces into the band.
    if (far && primaryFar) seq.push(...suite, host!);
    else seq.push(host!, ...suite);
    if (i < beds.length - 1 && singles.length > 0) seq.push(...singles.shift()!.reqs);
  });
  return [...singles.flatMap((u) => u.reqs), ...seq];
}

/** Band depth for a band holding bedrooms: about the side of a typical bedroom. */
function sleepingDepth(units: readonly Unit[]): number {
  const areas = units.filter((u) => u.sleeping).map((u) => grossG(u.reqs[0]!)).sort((a, b) => a - b);
  const median = areas[Math.floor((areas.length - 1) / 2)]!;
  return Math.min(ftG(14), Math.max(ftG(11), Math.round(Math.sqrt(median))));
}

interface Band {
  readonly units: readonly Unit[];
  depth: number;
  cols: Column[];
}

/**
 * Two bands either side of a hall: build each, give the band without bedrooms the depth that makes
 * it as wide as the other, and widen the narrower to match. Undefined when the two cannot be made
 * to match without stretching rooms out of shape.
 */
function bandPair(north: readonly Unit[], south: readonly Unit[], primaryFar: boolean, extras: Extras): { n: Band; s: Band; width: number } | undefined {
  const build = (units: readonly Unit[], depth: number): Band | undefined => {
    const cols = bandColumns(orderBand(units, primaryFar), depth, extras);
    return cols === undefined ? undefined : { units, depth, cols };
  };
  const hasBeds = (us: readonly Unit[]): boolean => us.some((u) => u.sleeping);
  const first = hasBeds(north) || !hasBeds(south) ? north : south;
  const second = first === north ? south : north;
  const a = build(first, hasBeds(first) ? sleepingDepth(first) : ftG(10));
  if (a === undefined) return undefined;
  let b: Band | undefined;
  if (second.length === 0) b = { units: [], depth: 0, cols: [] };
  else if (hasBeds(second)) b = build(second, sleepingDepth(second));
  else {
    const want = Math.ceil(sum(second.map((u) => u.area)) / Math.max(1, widthOf(a.cols)));
    b = build(second, Math.min(ftG(14), Math.max(ftG(6), want)));
  }
  if (b === undefined) return undefined;
  const width = Math.max(widthOf(a.cols), widthOf(b.cols));
  if (!stretch(a.cols, width, 1.45) || !stretch(b.cols, width, 1.45)) return undefined;
  return first === north ? { n: a, s: b, width } : { n: b, s: a, width };
}

/** Partitions of units into two bands, best balanced first; the unit holding the primary bedroom is always north. */
function partitions(units: readonly Unit[], keep: number): [Unit[], Unit[]][] {
  const m = units.length;
  if (m === 0) return [];
  if (m === 1) return [[[units[0]!], []]];
  const out: { score: number; mask: number }[] = [];
  const limit = m > 14 ? 0 : 1 << (m - 1);
  for (let mask = 0; mask < limit; mask++) {
    // Unit 0 (the largest) is always in the north band.
    const full = (mask << 1) | 1;
    if (full === (1 << m) - 1) continue;
    let an = 0;
    let as = 0;
    let bn = 0;
    let bs = 0;
    units.forEach((u, i) => {
      if ((full >> i) & 1) {
        an += u.area;
        bn += Number(u.sleeping);
      } else {
        as += u.area;
        bs += Number(u.sleeping);
      }
    });
    // Balanced areas; a band of only small rooms is fine, but not one of only bedrooms against nothing.
    out.push({ score: Math.abs(an - as) / (an + as) + (bn === 0 && bs === 0 ? 0.5 : 0), mask: full });
  }
  if (out.length === 0) {
    // Too many units to enumerate: alternate them by area.
    const n: Unit[] = [];
    const s: Unit[] = [];
    units.forEach((u, i) => (i % 2 === 0 ? n : s).push(u));
    return [[n, s]];
  }
  out.sort((p, q) => p.score - q.score || p.mask - q.mask);
  return out.slice(0, keep).map(({ mask }) => [units.filter((_, i) => (mask >> i) & 1), units.filter((_, i) => !((mask >> i) & 1))]);
}

// ── the private wing ───────────────────────────────────────────────────────────

interface Wing {
  readonly width: number;
  readonly depth: number;
  /** The hall's y-range, where the public rooms must meet it. */
  readonly hall: readonly [number, number];
  /** Cells in wing coordinates: x from 0 (the side facing the public rooms). */
  readonly cells: Placed[];
  readonly endSuite: boolean;
}

/** The primary suite as one column of `width` across the end of the hall, bedroom covering the hall's end. */
function endSuiteColumn(unit: Unit, depth: number, hall: readonly [number, number], south: boolean): { width: number; cells: Placed[] } | undefined {
  const [host, ...suite] = unit.reqs;
  const mins = suite.map((r) => minDim(r.fn));
  let width = Math.max(minDim('sleeping'), Math.ceil(unit.area / depth), sum(mins));
  // The bedroom covers the hall's end with a foot to spare; its suite takes the rest of the depth.
  const cover = (south ? hall[1] : depth - hall[0]) + ftG(1);
  let hb = Math.max(cover, Math.ceil(grossG(host!) / width));
  const rest = depth - hb;
  if (suite.length === 0) {
    if (depth / width > 2.2) return undefined;
    hb = depth;
  } else {
    const need = Math.max(...suite.map((r) => minDim(r.fn)), ftG(5));
    if (rest < need) {
      hb = depth - need;
      if (hb < cover) return undefined;
    }
    width = Math.max(width, sum(mins));
  }
  const cells: Placed[] = [];
  const by = south ? 0 : depth - hb;
  cells.push({ spec: specOf(host!), rect: { x0: 0, y0: by, x1: width, y1: by + hb } });
  if (suite.length > 0) {
    const sy0 = south ? hb : 0;
    const sy1 = south ? depth : depth - hb;
    const ws = fitSizes(suite.map(grossG), mins, width);
    if (ws === undefined) return undefined;
    let x = 0;
    suite.forEach((r, i) => {
      cells.push({ spec: specOf(r), rect: { x0: x, y0: sy0, x1: x + ws[i]!, y1: sy1 } });
      x += ws[i]!;
    });
  }
  return { width, cells };
}

interface WingParams {
  readonly endSuite: boolean;
  readonly part: number;
  readonly primaryFar: boolean;
  readonly flip: boolean;
}

/** The bedroom wing: two bands either side of a hall running east from the public rooms. */
function buildWing(units: readonly Unit[], p: WingParams, extras: Extras): Wing | undefined {
  let rest = [...units];
  let suite: Unit | undefined;
  if (p.endSuite) {
    suite = rest.find((u) => u.sleeping);
    if (suite === undefined) return undefined;
    rest = rest.filter((u) => u !== suite);
  }
  if (rest.length === 0) return undefined;
  const part = partitions(rest, 2)[p.part];
  if (part === undefined) return undefined;
  const [n0, s0] = p.flip ? [part[1], part[0]] : part;
  const pair = bandPair(n0, s0, p.primaryFar, extras);
  if (pair === undefined) return undefined;
  const ds = pair.s.depth;
  const dn = pair.n.depth;
  const depth = ds + HALL + dn;
  const hall: [number, number] = [ds, ds + HALL];
  let width = pair.width;
  const cells: Placed[] = [...placeBand(pair.s.cols, 0, 0, ds, true), ...placeBand(pair.n.cols, 0, ds + HALL, depth, false)];
  if (suite !== undefined) {
    const col = endSuiteColumn(suite, depth, hall, !p.flip);
    if (col === undefined) return undefined;
    cells.push(...shift(col.cells, width));
    width += col.width;
  }
  cells.push({ spec: extras.hall(), rect: { x0: 0, y0: ds, x1: pair.width, y1: ds + HALL } });
  return { width, depth, hall, cells, endSuite: suite !== undefined };
}

// ── the public rooms ───────────────────────────────────────────────────────────

/** How strongly two requests want to be side by side: the brief's adjacencies plus a few habits of house plans. */
function habit(adjacency: readonly Adjacency[], a: Req, b: Req): number {
  const fns = new Set([a.fn, b.fn]);
  let s = affinity(adjacency, a.item, b.item);
  if (fns.has('kitchen') && fns.has('dining')) s += 4;
  if (fns.has('living') && fns.has('dining')) s += 2;
  if (fns.has('living') && fns.has('circulation')) s += 3;
  if (fns.has('kitchen') && (fns.has('laundry') || fns.has('utility'))) s += 1;
  if (fns.has('garage') && (fns.has('laundry') || fns.has('utility') || fns.has('circulation'))) s += 3;
  if (fns.has('garage') && fns.has('kitchen')) s += 2;
  return s;
}

/** A chain: each next room the one that most wants to be beside the last, starting from `from`. */
function chain(from: Req, rest: readonly Req[], adjacency: readonly Adjacency[]): Req[] {
  const left = [...rest];
  const out: Req[] = [];
  let last = from;
  while (left.length > 0) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) {
      const d = habit(adjacency, last, left[i]!) - habit(adjacency, last, left[bi]!);
      if (d > 0 || (d === 0 && grossG(left[i]!) > grossG(left[bi]!))) bi = i;
    }
    last = left.splice(bi, 1)[0]!;
    out.push(last);
  }
  return out;
}

/** The room the hall opens into: living, else dining, else an entry, else the kitchen. */
export function hubOf(reqs: readonly Req[]): Req | undefined {
  for (const fn of ['living', 'dining', 'circulation', 'kitchen']) {
    const r = reqs.filter((x) => x.fn === fn).sort((a, b) => b.target - a.target || byKey(a, b))[0];
    if (r !== undefined) return r;
  }
  return reqs[0];
}

export type PublicArrangement = 'two-row-south' | 'two-row-north' | 'great-room';

interface PublicParams {
  readonly arrangement: PublicArrangement;
  readonly part: number;
  readonly reverse: boolean;
}

/**
 * Splits of the non-hub public rooms between two rows of depths rowA and rowB, best balanced first:
 * row A, which also holds `fixedA` square grid units (the hub), and row B as near the same width.
 */
function rowSplits(others: readonly Req[], rowA: number, rowB: number, keep: number, fixedA = 0): [Req[], Req[]][] {
  const m = others.length;
  const out: { score: number; mask: number }[] = [];
  const total = sum(others.map(grossG)) + fixedA;
  for (let mask = 0; mask < 1 << Math.min(m, 10); mask++) {
    let a = fixedA;
    others.forEach((r, i) => ((mask >> i) & 1 ? (a += grossG(r)) : 0));
    const want = (total * rowA) / (rowA + rowB);
    out.push({ score: Math.abs(a - want) / Math.max(1, total), mask });
  }
  out.sort((p, q) => p.score - q.score || p.mask - q.mask);
  return out.slice(0, keep).map(({ mask }) => [others.filter((_, i) => (mask >> i) & 1), others.filter((_, i) => !((mask >> i) & 1))]);
}

/**
 * The public block, `depth` deep, its east side meeting the hall at `hall` (when there is one) with
 * the hub room across the whole hall end. Cells in block coordinates, x from 0 at the west.
 */
function buildPublic(
  reqs: readonly Req[],
  depth: number,
  hall: readonly [number, number] | undefined,
  p: PublicParams,
  adjacency: readonly Adjacency[],
  extras: Extras,
): { width: number; cells: Placed[] } | undefined {
  const hub = hubOf(reqs);
  if (hub === undefined) return undefined;
  const others = reqs.filter((r) => r !== hub);
  const ordered = (rs: readonly Req[]): Req[] => {
    // Westward from the hub: the hub's closest partners nearest it. Rows are built west to east.
    const c = chain(hub, rs, adjacency);
    return p.reverse ? c : c.reverse();
  };
  if (p.arrangement === 'great-room') {
    const hw = Math.max(minDim(hub.fn), Math.ceil(grossG(hub) / depth));
    if (others.length === 0) return { width: hw, cells: [{ spec: specOf(hub), rect: { x0: 0, y0: 0, x1: hw, y1: depth } }] };
    let cells: Placed[];
    let width: number;
    if (others.length === 1) {
      const r = others[0]!;
      width = Math.max(minDim(r.fn), Math.ceil(grossG(r) / depth));
      cells = [{ spec: specOf(r), rect: { x0: 0, y0: 0, x1: width, y1: depth } }];
    } else {
      const split = rowSplits(others, 1, 1, 2)[p.part];
      if (split === undefined || split[0].length === 0 || split[1].length === 0) return undefined;
      const [south, north] = split;
      const as = sum(south.map(grossG));
      const an = sum(north.map(grossG));
      const lo = Math.max(...south.map((r) => Math.min(minDim(r.fn), ftG(7))));
      const hi = Math.max(...north.map((r) => Math.min(minDim(r.fn), ftG(7))));
      const ys = Math.min(depth - hi, Math.max(lo, Math.round((depth * as) / (as + an))));
      const cs = bandColumns(ordered(south), ys, extras);
      const cn = bandColumns(ordered(north), depth - ys, extras);
      if (cs === undefined || cn === undefined) return undefined;
      width = Math.max(widthOf(cs), widthOf(cn));
      if (!stretch(cs, width, 1.6) || !stretch(cn, width, 1.6)) return undefined;
      cells = [...placeBand(cs, 0, 0, ys, true), ...placeBand(cn, 0, ys, depth, false)];
    }
    cells.push({ spec: specOf(hub), rect: { x0: width, y0: 0, x1: width + hw, y1: depth } });
    return { width: width + hw, cells };
  }
  // Two rows; the hub at the east end of the row that holds the hall's end.
  const southHub = p.arrangement === 'two-row-south';
  let cut: number;
  if (hall !== undefined) cut = southHub ? hall[1] : hall[0];
  else {
    // No hall to meet: split the depth so the two rows hold their rooms at the same width.
    const split0 = rowSplits(others, 1, 1, 2, grossG(hub))[p.part];
    if (split0 === undefined) return undefined;
    const ah = sum([hub, ...split0[0]].map(grossG));
    const ao = sum(split0[1].map(grossG));
    const hubShare = Math.round((depth * ah) / (ah + ao));
    cut = southHub ? hubShare : depth - hubShare;
    const least = (rs: readonly Req[]): number => Math.max(ftG(7), ...rs.map((r) => minDim(r.fn)));
    const [hubLeast, otherLeast] = [least([hub, ...split0[0]]), least(split0[1])];
    cut = southHub ? Math.min(depth - otherLeast, Math.max(hubLeast, cut)) : Math.min(depth - hubLeast, Math.max(otherLeast, cut));
  }
  const hubDepth = southHub ? cut : depth - cut;
  const otherDepth = depth - hubDepth;
  if (otherDepth < ftG(7) || hubDepth < ftG(7)) return undefined;
  const split = hall === undefined ? rowSplits(others, 1, 1, 2, grossG(hub))[p.part] : rowSplits(others, hubDepth, otherDepth, 2, grossG(hub))[p.part];
  if (split === undefined) return undefined;
  const [withHub, apart] = split;
  if (apart.length === 0) return undefined;
  const ch = bandColumns(ordered(withHub), hubDepth, extras);
  const co = bandColumns(ordered(apart), otherDepth, extras);
  if (ch === undefined || co === undefined) return undefined;
  ch.push({ width: Math.max(minDim(hub.fn), Math.ceil(grossG(hub) / hubDepth)), cells: [{ spec: specOf(hub), size: hubDepth }] });
  const width = Math.max(widthOf(ch), widthOf(co));
  if (!stretch(ch, width, 1.6) || !stretch(co, width, 1.6)) return undefined;
  const cells = southHub
    ? [...placeBand(ch, 0, 0, cut, true), ...placeBand(co, 0, cut, depth, false)]
    : [...placeBand(co, 0, 0, cut, true), ...placeBand(ch, 0, cut, depth, false)];
  return { width, cells };
}

/** A column of rooms stacked south to north across `depth`, each sized by area, none below its least dimension. */
function stack(reqs: readonly Req[], depth: number): { width: number; cells: Placed[] } | undefined {
  if (reqs.length === 0) return undefined;
  const width = Math.max(...reqs.map((r) => minDim(r.fn)), Math.ceil(sum(reqs.map(grossG)) / depth));
  const sizes = fitSizes(
    reqs.map(grossG),
    reqs.map((r) => minDim(r.fn)),
    depth,
  );
  if (sizes === undefined) return undefined;
  let y = 0;
  const cells = reqs.map((r, i) => {
    const rect = { x0: 0, y0: y, x1: width, y1: y + sizes[i]! };
    y += sizes[i]!;
    return { spec: specOf(r), rect };
  });
  return { width, cells };
}

/** Stack order for a column of private units: bedrooms at the ends, with their suites beside them. */
function stackOrder(units: readonly Unit[], reverse: boolean): Req[] {
  const beds = units.filter((u) => u.sleeping);
  const singles = units.filter((u) => !u.sleeping);
  const seq: Req[] = [];
  beds.forEach((u, i) => {
    seq.push(...(i % 2 === 0 ? u.reqs : [...u.reqs].reverse()));
    if (i < beds.length - 1 && singles.length > 0) seq.push(...singles.shift()!.reqs);
  });
  seq.push(...singles.flatMap((u) => u.reqs));
  return reverse ? seq.reverse() : seq;
}

// ── assembling candidates ──────────────────────────────────────────────────────

export interface BuildInput {
  readonly reqs: readonly Req[];
  readonly adjacency: readonly Adjacency[];
}

export interface Variant {
  readonly family: Family;
  readonly key: string;
  readonly build: () => Layout | undefined;
}

function assemble(family: Family, key: string, structure: string, label: string, openPlan: boolean, width: number, depth: number, parts: readonly Placed[], notes: string[]): Layout {
  const spaces: Space[] = parts.map((p) => ({ key: p.spec.key, name: p.spec.name, fn: p.spec.fn, kind: p.spec.kind, ...(p.spec.req === undefined ? {} : { req: p.spec.req }), rect: p.rect }));
  return { family, variant: key, structure, label, width, depth, spaces, openPlan, notes };
}

const ARRANGEMENT_LABEL: Readonly<Record<PublicArrangement, string>> = {
  'two-row-south': 'living to the front',
  'two-row-north': 'living to the rear',
  'great-room': 'a full-depth great room',
};

/** Every variant of every strategy, in a fixed order. Each builds lazily: most are never evaluated in full. */
export function variants(input: BuildInput): Variant[] {
  const garage = input.reqs.filter((r) => r.zone === 'garage');
  const out: Variant[] = [];
  const arrangements: PublicArrangement[] = ['two-row-south', 'two-row-north', 'great-room'];
  for (const flexPrivate of [true, false]) {
    let priv = input.reqs.filter((r) => r.zone === 'private' || (flexPrivate && r.zone === 'flex'));
    let pub = input.reqs.filter((r) => r.zone === 'public' || (!flexPrivate && r.zone === 'flex'));
    if (pub.length === 0) {
      // No living spaces (a studio, a bunkhouse): the largest room that is not a bedroom is the hub.
      const hub = [...priv].filter((r) => r.fn !== 'sleeping' && r.host === undefined).sort((a, b) => b.target - a.target || byKey(a, b))[0];
      if (hub !== undefined) {
        pub = [hub];
        priv = priv.filter((r) => r !== hub);
      }
    }
    if (!flexPrivate && !input.reqs.some((r) => r.zone === 'flex')) continue;
    if (pub.length === 0) continue;
    const units = unitsOf(priv);
    const flexNote = input.reqs.some((r) => r.zone === 'flex') ? (flexPrivate ? 'laundry by the bedrooms' : 'laundry by the kitchen') : undefined;
    const withGarage = (parts: Placed[], depth: number, label: string): { parts: Placed[]; width: number; note?: string } => {
      if (garage.length === 0) return { parts, width: 0 };
      let x = 0;
      const gs: Placed[] = [];
      for (const g of garage) {
        const w = Math.max(minDim('garage'), Math.ceil(grossG(g) / depth));
        gs.push({ spec: specOf(g), rect: { x0: x, y0: 0, x1: x + w, y1: depth } });
        x += w;
      }
      return { parts: [...gs, ...shift(parts, x)], width: x, note: `${label}: garage at the west end` };
    };

    for (const openPlan of [true, false]) {
      const planNote = openPlan ? 'open plan: living, dining and kitchen divided by separators' : 'walled rooms joined by cased openings';
      // wing
      if (units.length >= 2)
        for (const endSuite of [false, true])
          for (const part of [0, 1])
            for (const primaryFar of [true, false])
              for (const flip of [false, true])
                for (const arrangement of arrangements)
                  for (const pp of [0, 1])
                    for (const reverse of [false, true]) {
                      const key = `wing-${endSuite ? 'end' : 'band'}-p${String(part)}${primaryFar ? 'f' : 'n'}${flip ? 'x' : ''}-${arrangement}-${String(pp)}${reverse ? 'r' : ''}${flexPrivate ? '' : '-flexpub'}${openPlan ? '-open' : '-walled'}`;
                      out.push({
                        family: 'wing',
                        key,
                        build: () => {
                          const extras = new Extras();
                          const wing = buildWing(units, { endSuite, part, primaryFar, flip }, extras);
                          if (wing === undefined) return undefined;
                          const pubBlock = buildPublic(pub, wing.depth, wing.hall, { arrangement, part: pp, reverse }, input.adjacency, extras);
                          if (pubBlock === undefined) return undefined;
                          const parts = [...pubBlock.cells, ...shift(wing.cells, pubBlock.width)];
                          const g = withGarage(parts, wing.depth, 'wing');
                          const label = `Bedroom wing along a hall${wing.endSuite ? ', primary suite across its end' : ''}; ${ARRANGEMENT_LABEL[arrangement]}${openPlan ? ', open plan' : ''}`;
                          const notes = [`bedrooms in a wing east of the living spaces, off a ${String(HALL / 2)}' hall`, planNote];
                          if (wing.endSuite) notes.push('the primary suite spans the end of the hall');
                          if (flexNote !== undefined) notes.push(flexNote);
                          if (g.note !== undefined) notes.push(g.note);
                          return assemble('wing', key, `wing|${wing.endSuite ? 'end' : 'band'}|${arrangement}|${String(flexPrivate)}`, label, openPlan, g.width + pubBlock.width + wing.width, wing.depth, g.parts, notes);
                        },
                      });
                    }
      // split: the primary suite on the far side of the public rooms
      const beds = units.filter((u) => u.sleeping);
      if (garage.length === 0 && beds.length >= 2 && units.length >= 3)
        for (const part of [0, 1])
          for (const primaryFar of [true, false])
            for (const arrangement of arrangements)
              for (const pp of [0, 1])
                for (const reverse of [false, true]) {
                  const key = `split-p${String(part)}${primaryFar ? 'f' : 'n'}-${arrangement}-${String(pp)}${reverse ? 'r' : ''}${flexPrivate ? '' : '-flexpub'}${openPlan ? '-open' : '-walled'}`;
                  out.push({
                    family: 'split',
                    key,
                    build: () => {
                      const extras = new Extras();
                      const primary = beds[0]!;
                      const rest = units.filter((u) => u !== primary);
                      const wing = buildWing(rest, { endSuite: false, part, primaryFar, flip: false }, extras);
                      if (wing === undefined) return undefined;
                      const suite = stack(reverse ? [...primary.reqs].reverse() : primary.reqs, wing.depth);
                      if (suite === undefined) return undefined;
                      const pubBlock = buildPublic(pub, wing.depth, wing.hall, { arrangement, part: pp, reverse }, input.adjacency, extras);
                      if (pubBlock === undefined) return undefined;
                      const parts = [...suite.cells, ...shift(pubBlock.cells, suite.width), ...shift(wing.cells, suite.width + pubBlock.width)];
                      const label = `Split bedrooms: primary suite west, other bedrooms east along a hall; ${ARRANGEMENT_LABEL[arrangement]}${openPlan ? ', open plan' : ''}`;
                      const notes = ['primary suite on the far side of the living spaces from the other bedrooms', planNote];
                      if (flexNote !== undefined) notes.push(flexNote);
                      return assemble('split', key, `split|${arrangement}|${String(flexPrivate)}`, label, openPlan, suite.width + pubBlock.width + wing.width, wing.depth, parts, notes);
                    },
                  });
                }
      // compact: no hall
      const privCount = priv.length;
      if (privCount <= 4)
        for (const arrangement of arrangements)
          for (const pp of [0, 1])
            for (const reverse of [false, true]) {
              const key = `compact-${arrangement}-${String(pp)}${reverse ? 'r' : ''}${flexPrivate ? '' : '-flexpub'}${openPlan ? '-open' : '-walled'}`;
              out.push({
                family: 'compact',
                key,
                build: () => {
                  const extras = new Extras();
                  const total = sum(input.reqs.map(grossG));
                  const order = stackOrder(units, reverse);
                  const least = sum(order.map((r) => minDim(r.fn)));
                  const depth = Math.max(least, Math.min(ftG(36), Math.max(ftG(16), Math.round(Math.sqrt(total / 1.35)))));
                  const col = order.length === 0 ? { width: 0, cells: [] } : stack(order, depth);
                  if (col === undefined) return undefined;
                  const pubBlock = buildPublic(pub, depth, undefined, { arrangement, part: pp, reverse }, input.adjacency, extras);
                  if (pubBlock === undefined) return undefined;
                  const parts = [...pubBlock.cells, ...shift(col.cells, pubBlock.width)];
                  const g = withGarage(parts, depth, 'compact');
                  const label = `Compact: private rooms open off the living spaces, no hall; ${ARRANGEMENT_LABEL[arrangement]}${openPlan ? ', open plan' : ''}`;
                  const notes = ['no hall: every private room opens off a living space or its bedroom', planNote];
                  if (flexNote !== undefined) notes.push(flexNote);
                  if (g.note !== undefined) notes.push(g.note);
                  return assemble('compact', key, `compact|${arrangement}|${String(flexPrivate)}`, label, openPlan, g.width + pubBlock.width + col.width, depth, g.parts, notes);
                },
              });
            }
    }
  }
  return out;
}
