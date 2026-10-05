/**
 * An abstract layout: rectangles on the 6-inch grid that tile a rectangular footprint, one per
 * space. From the tiling the solver derives the plane graph it will draw — every rectangle corner
 * is a junction, and every rectangle side is split wherever another corner lies on it — so the
 * walls it emits are already planar and never need Ops normalization to split them (Ops 5.2).
 */
import type { Req } from './program.js';

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A room (from the brief), a hall the solver adds for circulation, or a closet that fills a corner. */
export type SpaceKind = 'room' | 'hall' | 'closet';

export interface Space {
  readonly key: string;
  readonly name: string;
  readonly fn: string;
  readonly kind: SpaceKind;
  readonly req?: Req;
  rect: Rect;
}

export type Family = 'wing' | 'split' | 'compact';

export interface Layout {
  readonly family: Family;
  /** A short, stable description of the variant, used in the candidate's ID. */
  readonly variant: string;
  /** The variant's big decisions (strategy, arrangement, suite, laundry side), for choosing a varied set. */
  readonly structure: string;
  readonly label: string;
  /** Footprint, in grid units. The front of the house is its south side (y = 0). */
  width: number;
  depth: number;
  readonly spaces: Space[];
  /** Whether the living, dining and kitchen open into each other (separators) or are walled (cased openings). */
  readonly openPlan: boolean;
  readonly notes: string[];
}

export type Pt = readonly [number, number];

/**
 * An elementary segment of the plane graph, `a` before `b` (axis aligned, so `a` is to the west of
 * or south of `b`). `left` is the space to the left walking from `a` to `b` — above a horizontal
 * segment, west of a vertical one — and `right` the other; `undefined` is outside the house.
 */
export interface Seg {
  readonly a: Pt;
  readonly b: Pt;
  readonly left: string | undefined;
  readonly right: string | undefined;
  readonly length: number;
  readonly horizontal: boolean;
  /** Whether each end lies on the footprint's outline — where an exterior wall's thickness reaches. */
  readonly aOut: boolean;
  readonly bOut: boolean;
}

export const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
export const rw = (r: Rect): number => r.x1 - r.x0;
export const rh = (r: Rect): number => r.y1 - r.y0;

/** Whether the spaces tile the footprint exactly: inside it, no overlaps, nothing left over. */
export function tiles(layout: Layout): boolean {
  let sum = 0;
  const rs = layout.spaces.map((s) => s.rect);
  for (const r of rs) {
    if (!(r.x0 < r.x1 && r.y0 < r.y1)) return false;
    if (r.x0 < 0 || r.y0 < 0 || r.x1 > layout.width || r.y1 > layout.depth) return false;
    sum += area(r);
  }
  if (sum !== layout.width * layout.depth) return false;
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const p = rs[i]!;
      const q = rs[j]!;
      if (p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) return false;
    }
  return true;
}

const ptKey = (p: Pt): string => `${String(p[0])},${String(p[1])}`;

/** The space containing a point strictly inside some rectangle, or undefined outside. */
function spaceAt(spaces: readonly Space[], x: number, y: number): string | undefined {
  for (const s of spaces) {
    const r = s.rect;
    if (r.x0 < x && x < r.x1 && r.y0 < y && y < r.y1) return s.key;
  }
  return undefined;
}

/** The plane graph of a tiling: its elementary segments, sorted (horizontal first, then by position). */
export function segments(layout: Layout): Seg[] {
  const corners = new Map<string, Pt>();
  for (const s of layout.spaces) {
    const r = s.rect;
    for (const p of [
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x0, r.y1],
      [r.x1, r.y1],
    ] as const)
      corners.set(ptKey(p), p);
  }
  const pts = [...corners.values()];
  const out = new Map<string, Seg>();
  const add = (a: Pt, b: Pt): void => {
    const key = `${ptKey(a)}|${ptKey(b)}`;
    if (out.has(key)) return;
    const horizontal = a[1] === b[1];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const e = 0.25;
    const left = horizontal ? spaceAt(layout.spaces, mx, my + e) : spaceAt(layout.spaces, mx - e, my);
    const right = horizontal ? spaceAt(layout.spaces, mx, my - e) : spaceAt(layout.spaces, mx + e, my);
    const out_ = (p: Pt): boolean => p[0] === 0 || p[1] === 0 || p[0] === layout.width || p[1] === layout.depth;
    out.set(key, { a, b, left, right, length: horizontal ? b[0] - a[0] : b[1] - a[1], horizontal, aOut: out_(a), bOut: out_(b) });
  };
  for (const s of layout.spaces) {
    const r = s.rect;
    for (const y of [r.y0, r.y1]) {
      const xs = pts.filter((p) => p[1] === y && p[0] > r.x0 && p[0] < r.x1).map((p) => p[0]);
      const stops = [r.x0, ...xs.sort((m, n) => m - n), r.x1];
      for (let i = 0; i + 1 < stops.length; i++) add([stops[i]!, y], [stops[i + 1]!, y]);
    }
    for (const x of [r.x0, r.x1]) {
      const ys = pts.filter((p) => p[0] === x && p[1] > r.y0 && p[1] < r.y1).map((p) => p[1]);
      const stops = [r.y0, ...ys.sort((m, n) => m - n), r.y1];
      for (let i = 0; i + 1 < stops.length; i++) add([x, stops[i]!], [x, stops[i + 1]!]);
    }
  }
  return [...out.values()].sort(
    (p, q) => Number(q.horizontal) - Number(p.horizontal) || p.a[1] - q.a[1] || p.a[0] - q.a[0] || p.b[0] - q.b[0] || p.b[1] - q.b[1],
  );
}

/** The segments between two spaces (in either order). */
export const between = (segs: readonly Seg[], p: string, q: string): Seg[] =>
  segs.filter((s) => (s.left === p && s.right === q) || (s.left === q && s.right === p));

/** A segment's outside side, for an exterior segment. */
export const isExterior = (s: Seg): boolean => s.left === undefined || s.right === undefined;

/** The space of an exterior segment. */
export const insideOf = (s: Seg): string => (s.left ?? s.right)!;

/** An order-free key for a pair of keys. */
export const pairKey = (p: string, q: string): string => (p < q ? `${p}\u0000${q}` : `${q}\u0000${p}`);

/** A stable signature of the tiling: two candidates with the same signature draw the same rooms. */
export function signature(layout: Layout): string {
  return layout.spaces
    .map((s) => `${s.key}:${String(s.rect.x0)},${String(s.rect.y0)},${String(s.rect.x1)},${String(s.rect.y1)}`)
    .sort()
    .join(';');
}
