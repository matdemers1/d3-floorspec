/**
 * Dimensions and annotation (FLR-T-18.11, FLR-ADR-047): one layout that the editor's canvas,
 * render2d's SVG and the worker's PDF all draw, so the three can never disagree about where a
 * dimension goes or what it says.
 *
 * In two steps:
 *
 * 1. **Strings, in the model** (base units, y up), from a level's walls, openings and rooms:
 *    - the **exterior** strings of each side of the building, nearest first — the openings located
 *      (each door and window's centre line between the corners), the major jogs, and the overall
 *      size. Read off the building's outer boundary (the union of the wall and junction pieces): a
 *      corner is where the boundary turns by 20° or more, or where an arc wall ends; an arc's
 *      furthest point out is measured to on the side it bulges toward; points closer than 6" are
 *      merged (the stronger kept); a string that says nothing the next one out does not is left out;
 *    - an **interior** string across each room each way, wall face to wall face, beside its label;
 *    - the person's own strings (FS_annotation's dimensions, resolved by the engine) and notes;
 *    - the door and window **tags**: each opening's mark, off the face it is read from.
 * 2. **Paper**, given the drawing's frame (model → paper, y down), its text metrics and the units:
 *    every line, tick, arrowhead, text and tag as primitives in paper units. Exterior strings stack
 *    at fixed paper offsets beyond everything drawn; a length that does not fit its span moves to a
 *    row of its own, further out, with a leader to its span — and the strings beyond it move out by
 *    that row, so nothing overlaps.
 *
 * Nothing here is normative: the lengths printed are differences of the engine's own integers,
 * formatted once by the caller's formatter. Isomorphic, deterministic, no clock.
 */
import type { OpeningKind, Pt, Scene } from './scene.js';
import { ccw, insideRings, mergeCollinear, outerLoops, unionOutline, type XY } from './outline.js';

// ── the source ────────────────────────────────────────────────────────────────

/** A wall, as dimensioning reads it. */
export interface AnnoWall {
  readonly id: string;
  /** Its outline (Core 5.7): startRight → endRight → endLeft → startLeft, through an arc's face points. */
  readonly outline: readonly Pt[];
  readonly start: Pt;
  readonly end: Pt;
  /** Face offsets (Core 5.4): location line to the left face, and to the right. */
  readonly a: number;
  readonly b: number;
  /** An arc wall (Core 0.4, chapter 21). */
  readonly arc: boolean;
}

export interface AnnoOpening {
  readonly id: string;
  readonly wall: string;
  readonly kind: OpeningKind;
  /** On the wall's location line (Core 7.4). */
  readonly start: Pt;
  readonly end: Pt;
  readonly swing: 'left' | 'right';
}

export interface AnnoRoom {
  readonly id: string;
  readonly title: string;
  readonly outer: readonly Pt[];
  readonly holes: readonly (readonly Pt[])[];
  /** Where its label is drawn, model units: the interior strings keep clear of it. */
  readonly label: XY;
}

/** One level, as dimensioning reads it: from a render2d scene (`annoSourceOf`) or the editor's level view. */
export interface AnnoSource {
  readonly walls: readonly AnnoWall[];
  /** Junction fills (Core 5.6). */
  readonly fills: readonly (readonly Pt[])[];
  readonly openings: readonly AnnoOpening[];
  readonly rooms: readonly AnnoRoom[];
}

// ── strings in the model ──────────────────────────────────────────────────────

export type Side = 'N' | 'S' | 'E' | 'W';
export const SIDES: readonly Side[] = ['N', 'S', 'E', 'W'];

/** A point on a string: where along it, and the feature its extension line starts from. */
export interface DimStop {
  /** Model units along the string's direction `u`, from its origin. */
  readonly along: number;
  /** The feature measured to (model): the extension line runs from it to the string. */
  readonly feature: XY;
}

export type DimGroup = 'exterior' | 'interior' | 'custom';

/** A dimension string in the model: its line, its stops, and the lengths it prints. */
export interface DimString {
  /** `ext:N:0`, `room:R3:h`, or a custom string's ID (`DM1`). */
  readonly id: string;
  readonly group: DimGroup;
  /** The exterior side, for an exterior string. */
  readonly side?: Side;
  /** 0 nearest the building (exterior strings). */
  readonly tier: number;
  readonly kind: 'openings' | 'jogs' | 'overall' | 'room' | 'custom';
  /** Unit direction along the string (model), reading left to right or bottom to top. */
  readonly u: XY;
  /** Unit normal (model): the side its text sits on, and the way extra rows and outer tiers go. */
  readonly n: XY;
  /** A point on its line at along 0 (model). For an exterior string, on the outermost edge drawn; its tier's paper offset is added. */
  readonly origin: XY;
  /** Ascending along. */
  readonly stops: readonly DimStop[];
  /** What each span prints, base units: stop i to i + 1. Exact integers where the model's are. */
  readonly lengths: readonly number[];
  /** Extension lines: from each feature (exterior, custom), or none (interior, from face to face). */
  readonly extension: boolean;
  /**
   * An exterior string of a recessed face — a courtyard's, an L's inner wall — locating its openings
   * just off that face rather than out with the side's strings.
   */
  readonly local?: boolean;
}

/** A face further in than this from its side's outermost is recessed: its openings get a string of their own (4 ft). */
export const RECESSED = 4 * 12 * 32_512;

/** Below this, two points of a string are one (6"). */
export const MIN_SPAN = 6 * 32_512;
/** A boundary vertex turning by less than this is not a corner: a curve's facets, a slight kink. */
const SHARP = (20 * Math.PI) / 180;

const OUT: Readonly<Record<Side, XY>> = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
const horizontalSide = (s: Side): boolean => s === 'N' || s === 'S';
const alongOf = (s: Side, p: XY): number => (horizontalSide(s) ? p[0] : p[1]);
const acrossOf = (s: Side, p: XY): number => (horizontalSide(s) ? p[1] : p[0]);
const key = (p: XY): string => `${p[0]},${p[1]}`;

/** Unit vector along a segment and its left normal. */
function axes(a: XY, b: XY): { u: XY; n: XY; len: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  return len === 0 ? { u: [1, 0], n: [0, 1], len } : { u: [dx / len, dy / len], n: [-dy / len, dx / len], len };
}

/** Does the ray o + t·d (t > 0) cross segment ab? */
function crosses(o: XY, d: XY, a: XY, b: XY): boolean {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (den === 0) return false;
  const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
  const s = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
  return t > 1 && s > 1e-9 && s < 1 - 1e-9;
}

/** The building's outer boundary: one or more counter-clockwise loops (the walls' outside faces). */
export function outerBoundary(src: AnnoSource): Pt[][] {
  const pieces = [
    ...src.walls.filter((w) => w.outline.length >= 3).map((w) => ({ ring: ccw(w.outline), exterior: true })),
    ...src.fills.filter((r) => r.length >= 3).map((r) => ({ ring: ccw(r), exterior: true })),
  ];
  return outerLoops(mergeCollinear(unionOutline(pieces)));
}

interface Feature {
  readonly p: XY;
  /** 3 an overall end, 2 a corner, 1 an arc's extreme, 0 an opening's centre: the stronger survives a merge. */
  readonly strength: number;
}

/** The corners of an outer loop, and each curved run's points between them. */
function cornersOf(loop: readonly Pt[], arcEnds: ReadonlySet<string>): { corners: Set<number>; runs: number[][] } {
  const n = loop.length;
  const corners = new Set<number>();
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n]!;
    const p = loop[i]!;
    const b = loop[(i + 1) % n]!;
    const t = Math.abs(Math.atan2((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]), (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1])));
    if (t >= SHARP || arcEnds.has(key(p))) corners.add(i);
  }
  const runs: number[][] = [];
  if (corners.size === 0) {
    runs.push([...Array(n).keys()]);
    return { corners, runs };
  }
  const first = Math.min(...corners);
  let run: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (corners.has(i)) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push(i);
  }
  return { corners, runs };
}

/** Merge points of a string closer than MIN_SPAN: the stronger feature stays. */
function mergeClose(points: readonly { along: number; f: Feature }[]): { along: number; f: Feature }[] {
  const sorted = [...points].sort((a, b) => a.along - b.along || b.f.strength - a.f.strength);
  const out: { along: number; f: Feature }[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || p.along - last.along >= MIN_SPAN) {
      out.push(p);
      continue;
    }
    // The first and last of a string are its extent's ends: never moved.
    if (p.f.strength > last.f.strength && !(last.f.strength === 3)) out[out.length - 1] = p;
  }
  return out;
}

/**
 * The exterior dimension strings of a level, per side, nearest the building first: openings
 * located, then jogs, then the overall size. `extent` is everything the drawing shows (door swings,
 * slabs, furniture): the strings sit beyond it. Their paper offsets are the layout's.
 */
export function exteriorStrings(src: AnnoSource, extent: { minX: number; minY: number; maxX: number; maxY: number }): DimString[] {
  const loops = outerBoundary(src);
  if (loops.length === 0) return [];
  const edges: [XY, XY][] = loops.flatMap((l) => l.map((p, i) => [p, l[(i + 1) % l.length]!] as [XY, XY]));
  const outside = (p: XY): boolean => !loops.some((l) => insideRings(p[0], p[1], [l]));
  const seen = (p: XY, side: Side): boolean => !edges.some(([a, b]) => crosses(p, OUT[side], a, b));

  // Where an arc wall ends: the outline vertices nearest its start and its end.
  const arcEnds = new Set<string>();
  for (const w of src.walls) {
    if (!w.arc || w.outline.length < 4) continue;
    for (const end of [w.start, w.end]) {
      const near = [...w.outline].sort((p, q) => Math.hypot(p[0] - end[0], p[1] - end[1]) - Math.hypot(q[0] - end[0], q[1] - end[1])).slice(0, 2);
      for (const p of near) arcEnds.add(key(p));
    }
  }

  let body = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const l of loops)
    for (const [x, y] of l) body = { minX: Math.min(body.minX, x), minY: Math.min(body.minY, y), maxX: Math.max(body.maxX, x), maxY: Math.max(body.maxY, y) };

  // Per side: corners and arcs' extremes seen from it.
  const features = new Map<Side, Feature[]>(SIDES.map((s) => [s, []]));
  for (const loop of loops) {
    const { corners, runs } = cornersOf(loop, arcEnds);
    for (const side of SIDES) {
      const list = features.get(side)!;
      for (const i of corners) if (seen(loop[i]!, side)) list.push({ p: loop[i]!, strength: 2 });
      // A curve's furthest point toward the side, when it bulges past both of its ends.
      for (const run of runs) {
        if (run.length < 2) continue;
        const n = loop.length;
        const ends = [loop[(run[0]! - 1 + n) % n]!, loop[(run[run.length - 1]! + 1) % n]!];
        const out = (p: XY): number => p[0] * OUT[side][0] + p[1] * OUT[side][1];
        const best = run.reduce((b, i) => (out(loop[i]!) > out(loop[b]!) ? i : b), run[0]!);
        if (out(loop[best]!) > Math.max(...ends.map(out)) + MIN_SPAN / 2 && seen(loop[best]!, side)) list.push({ p: loop[best]!, strength: 1 });
      }
    }
  }

  // Doors and windows in an outside wall, by the side their outside faces, where that face is seen.
  const openings = new Map<Side, Feature[]>(SIDES.map((s) => [s, []]));
  const recessed = new Map<number, { side: Side; list: Feature[] }>();
  const walls = new Map(src.walls.map((w) => [w.id, w]));
  const INCH = 32_512;
  for (const o of src.openings) {
    if (o.kind === 'opening') continue;
    const w = walls.get(o.wall);
    if (w === undefined) continue;
    const { n, len } = axes(o.start, o.end);
    if (len === 0) continue;
    const mid: XY = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    const leftOut = outside([mid[0] + n[0] * (w.a + INCH), mid[1] + n[1] * (w.a + INCH)]);
    const rightOut = outside([mid[0] - n[0] * (w.b + INCH), mid[1] - n[1] * (w.b + INCH)]);
    if (leftOut === rightOut) continue;
    const out: XY = leftOut ? n : [-n[0], -n[1]];
    const side: Side = Math.abs(out[0]) > Math.abs(out[1]) ? (out[0] > 0 ? 'E' : 'W') : out[1] > 0 ? 'N' : 'S';
    const face: XY = leftOut ? [mid[0] + n[0] * w.a, mid[1] + n[1] * w.a] : [mid[0] - n[0] * w.b, mid[1] - n[1] * w.b];
    if (!seen([face[0] + out[0] * INCH, face[1] + out[1] * INCH], side)) continue;
    const p: XY = [Math.round(face[0]), Math.round(face[1])];
    const extreme = side === 'N' ? body.maxY : side === 'S' ? body.minY : side === 'E' ? body.maxX : body.minX;
    if (Math.abs(acrossOf(side, p) - extreme) <= RECESSED) {
      openings.get(side)!.push({ p, strength: 0 });
      continue;
    }
    // A recessed face: the boundary edge it is on, and its openings, located on a string of its own.
    const at = edges.findIndex(([a, b]) => {
      const { u, n: nn, len: l } = axes(a, b);
      const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
      return l > 0 && Math.abs((p[0] - a[0]) * nn[0] + (p[1] - a[1]) * nn[1]) <= INCH && t >= 0 && t <= l;
    });
    if (at < 0) continue;
    const group = recessed.get(at) ?? { side, list: [] as Feature[] };
    group.list.push({ p, strength: 0 });
    recessed.set(at, group);
  }

  const strings: DimString[] = [];
  for (const side of SIDES) {
    const h = horizontalSide(side);
    const lo = h ? body.minX : body.minY;
    const hi = h ? body.maxX : body.maxY;
    if (!(hi > lo)) continue;
    const corners = features.get(side)!;
    // The extent's ends: the outermost feature toward the side at each end, for its extension line.
    const endFeature = (at: number): Feature => {
      const cands = [...corners, ...loops.flat().map((p) => ({ p, strength: 2 }))].filter((f) => alongOf(side, f.p) === at);
      const outward = side === 'N' || side === 'E' ? 1 : -1;
      const best = cands.reduce<Feature | undefined>((b, f) => (b === undefined || acrossOf(side, f.p) * outward > acrossOf(side, b.p) * outward ? f : b), undefined);
      return { p: best?.p ?? (h ? [at, side === 'N' ? body.maxY : body.minY] : [side === 'E' ? body.maxX : body.minX, at]), strength: 3 };
    };
    const ends = [{ along: lo, f: endFeature(lo) }, { along: hi, f: endFeature(hi) }];
    const pts = (fs: readonly Feature[]): { along: number; f: Feature }[] => mergeClose([...ends, ...fs.filter((f) => alongOf(side, f.p) > lo && alongOf(side, f.p) < hi).map((f) => ({ along: alongOf(side, f.p), f }))]);
    const overall = ends;
    const jogs = pts(corners);
    const located = pts([...corners, ...openings.get(side)!]);
    const same = (a: readonly { along: number }[], b: readonly { along: number }[]): boolean => a.length === b.length && a.every((p, i) => p.along === b[i]!.along);
    const tiers: { kind: DimString['kind']; pts: { along: number; f: Feature }[] }[] = [];
    if (!same(located, jogs)) tiers.push({ kind: 'openings', pts: located });
    if (!same(jogs, overall)) tiers.push({ kind: 'jogs', pts: jogs });
    tiers.push({ kind: 'overall', pts: overall });
    const u: XY = h ? [1, 0] : [0, 1];
    const edge = side === 'N' ? extent.maxY : side === 'S' ? extent.minY : side === 'E' ? extent.maxX : extent.minX;
    const origin: XY = h ? [0, edge] : [edge, 0];
    tiers.forEach((t, tier) => {
      const stops = t.pts.map((p) => ({ along: p.along, feature: p.f.p }));
      strings.push({
        id: `ext:${side}:${String(tier)}`,
        group: 'exterior',
        side,
        tier,
        kind: t.kind,
        u,
        n: OUT[side],
        origin,
        stops,
        lengths: stops.slice(1).map((s, i) => s.along - stops[i]!.along),
        extension: true,
      });
    });
  }
  // Each recessed face's own string: its ends and its openings, just off it.
  for (const [at, { side, list }] of [...recessed].sort((a, b) => a[0] - b[0])) {
    const [a, b] = edges[at]!;
    const h = horizontalSide(side);
    const [lo, hi] = [Math.min(alongOf(side, a), alongOf(side, b)), Math.max(alongOf(side, a), alongOf(side, b))];
    const loP = alongOf(side, a) === lo ? a : b;
    const hiP = loP === a ? b : a;
    const pts = mergeClose([{ along: lo, f: { p: loP, strength: 3 } }, { along: hi, f: { p: hiP, strength: 3 } }, ...list.map((f) => ({ along: alongOf(side, f.p), f }))]);
    const stops = pts.map((p) => ({ along: p.along, feature: p.f.p }));
    const across = acrossOf(side, a);
    strings.push({
      id: `ext:${side}:face${String(at)}`,
      group: 'exterior',
      side,
      tier: 0,
      kind: 'openings',
      u: h ? [1, 0] : [0, 1],
      n: OUT[side],
      origin: h ? [0, across] : [across, 0],
      stops,
      lengths: stops.slice(1).map((s, i) => s.along - stops[i]!.along),
      extension: true,
      local: true,
    });
  }
  return strings;
}

/** How far a point reaches left, right, down and up inside rings before meeting an edge. */
function reach(p: XY, rings: readonly (readonly XY[])[]): { left: number; right: number; down: number; up: number } {
  const [x, y] = p;
  let left = Infinity;
  let right = Infinity;
  let down = Infinity;
  let up = Infinity;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, ay] = r[j]!;
      const [bx, by] = r[i]!;
      if (ay > y !== by > y) {
        const xi = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (xi <= x) left = Math.min(left, x - xi);
        else right = Math.min(right, xi - x);
      }
      if (ax > x !== bx > x) {
        const yi = ay + ((x - ax) * (by - ay)) / (bx - ax);
        if (yi <= y) down = Math.min(down, y - yi);
        else up = Math.min(up, yi - y);
      }
    }
  return { left, right, down, up };
}

/** A room narrower than this either way has no interior strings: a closet, a powder room (8 ft). */
const ROOM_MIN = 8 * 12 * 32_512;

/** The paper space a room's label takes, so its interior strings keep clear of it. */
export interface LabelClear {
  /** Half the label's width and height, paper units. */
  readonly halfW: number;
  readonly halfH: number;
}

/**
 * Each room's interior strings: across it (wall face to wall face) below its label, and up it to
 * the label's left — in model units; `k` (paper per base unit) and `clear` place them off the label.
 * A room too small for its text at this scale has none.
 */
export function roomStrings(src: AnnoSource, k: number, clear: (room: AnnoRoom) => LabelClear, gap: number): DimString[] {
  const out: DimString[] = [];
  for (const r of src.rooms) {
    const rings = [r.outer, ...r.holes];
    const whole = reach(r.label, rings);
    if (!(whole.left + whole.right >= ROOM_MIN && whole.down + whole.up >= ROOM_MIN)) continue;
    const c = clear(r);
    // Across: under the label by its half height and a gap.
    const yh = r.label[1] - (c.halfH + gap) / k;
    const ph: XY = [r.label[0], yh];
    if (insideRings(ph[0], ph[1], rings)) {
      const s = reach(ph, rings);
      if (Number.isFinite(s.left) && Number.isFinite(s.right)) {
        const x0 = Math.round(ph[0] - s.left);
        const x1 = Math.round(ph[0] + s.right);
        if (x1 - x0 >= ROOM_MIN)
          out.push({ id: `room:${r.id}:h`, group: 'interior', tier: 0, kind: 'room', u: [1, 0], n: [0, 1], origin: [0, yh], stops: [{ along: x0, feature: [x0, yh] }, { along: x1, feature: [x1, yh] }], lengths: [x1 - x0], extension: false });
      }
    }
    // Up: left of the label by its half width and a gap.
    const xv = r.label[0] - (c.halfW + gap) / k;
    const pv: XY = [xv, r.label[1]];
    if (insideRings(pv[0], pv[1], rings)) {
      const s = reach(pv, rings);
      if (Number.isFinite(s.down) && Number.isFinite(s.up)) {
        const y0 = Math.round(pv[1] - s.down);
        const y1 = Math.round(pv[1] + s.up);
        if (y1 - y0 >= ROOM_MIN)
          out.push({ id: `room:${r.id}:v`, group: 'interior', tier: 0, kind: 'room', u: [0, 1], n: [-1, 0], origin: [xv, 0], stops: [{ along: y0, feature: [xv, y0] }, { along: y1, feature: [xv, y1] }], lengths: [y1 - y0], extension: false });
      }
    }
  }
  return out;
}

/** A person's own string, resolved by the engine (FS_annotation): its anchors on its line, in order, and the exact lengths. */
export interface CustomDimension {
  readonly id: string;
  /** Direction lengths are measured along (model, not necessarily unit). */
  readonly direction: XY;
  readonly anchors: readonly { readonly feature: XY; readonly onLine: XY }[];
  readonly lengths: readonly number[];
}

/** A custom string as a DimString: read left to right (or bottom to top), its text above it. */
export function customString(d: CustomDimension): DimString | null {
  if (d.anchors.length < 2) return null;
  const len = Math.hypot(d.direction[0], d.direction[1]);
  if (len === 0) return null;
  let u: XY = [d.direction[0] / len, d.direction[1] / len];
  // Reading direction: rightwards, or upwards when it is nearer vertical.
  if (Math.abs(u[0]) >= Math.abs(u[1]) ? u[0] < 0 : u[1] < 0) u = [0 - u[0] + 0, 0 - u[1] + 0];
  const origin = d.anchors[0]!.onLine;
  const along = (p: XY): number => (p[0] - origin[0]) * u[0] + (p[1] - origin[1]) * u[1];
  const stops = d.anchors.map((a) => ({ along: along(a.onLine), feature: a.feature }));
  // Spans keep the order the anchors were given in; the lengths are the engine's.
  const order = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.along - b.s.along);
  const monotone = order.every((o, j) => o.i === j) || order.every((o, j) => o.i === stops.length - 1 - j);
  const sorted = order.map((o) => o.s);
  const lengths = monotone ? (order[0]!.i === 0 ? d.lengths : [...d.lengths].reverse()) : sorted.slice(1).map((s, i) => Math.round(Math.abs(s.along - sorted[i]!.along)));
  return { id: d.id, group: 'custom', tier: 0, kind: 'custom', u, n: [-u[1], u[0]], origin, stops: sorted, lengths, extension: true };
}

// ── tags ──────────────────────────────────────────────────────────────────────

/** A door or window tag: off the face at `base`, along `normal` (unit, model). */
export interface Tag {
  readonly kind: 'door' | 'window';
  readonly id: string;
  readonly mark: string;
  readonly base: XY;
  readonly normal: XY;
}

/** The openings of a level in reading order, for marks: `{ id, kind, start, end }` each. */
export interface MarkSource {
  readonly openings: readonly { readonly id: string; readonly kind: OpeningKind; readonly start: Pt; readonly end: Pt }[];
}

/**
 * Number the doors and windows of a whole document: D1…, W1… in reading order — level by
 * elevation (the caller's order), then top to bottom, left to right by the opening's midpoint, then ID.
 */
export function openingMarks(levels: readonly MarkSource[]): Map<string, string> {
  const marks = new Map<string, string>();
  for (const kind of ['door', 'window'] as const) {
    let n = 0;
    for (const level of levels) {
      const list = level.openings
        .filter((o) => o.kind === kind)
        .map((o) => ({ id: o.id, x: (o.start[0] + o.end[0]) / 2, y: (o.start[1] + o.end[1]) / 2 }))
        .sort((a, b) => (a.y !== b.y ? b.y - a.y : a.x !== b.x ? a.x - b.x : a.id < b.id ? -1 : 1));
      for (const o of list) marks.set(o.id, `${kind === 'door' ? 'D' : 'W'}${String(++n)}`);
    }
  }
  return marks;
}

/**
 * Where each door and window's tag goes: a door's on the side it does not swing to, a window's
 * outside the building when one side is (read from the street).
 */
export function tagsOf(src: AnnoSource, marks: ReadonlyMap<string, string>): Tag[] {
  const walls = new Map(src.walls.map((w) => [w.id, w]));
  const rings = src.rooms.map((r) => [r.outer, ...r.holes]);
  const loops = outerBoundary(src);
  const inside = (p: XY): boolean => (loops.length > 0 ? loops.some((l) => insideRings(p[0], p[1], [l])) : rings.some((rs) => insideRings(p[0], p[1], rs)));
  const out: Tag[] = [];
  for (const o of src.openings) {
    if (o.kind === 'opening') continue;
    const mark = marks.get(o.id);
    const w = walls.get(o.wall);
    if (mark === undefined || w === undefined) continue;
    const { n, len } = axes(o.start, o.end);
    if (len === 0) continue;
    const mid: XY = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    if (o.kind === 'door') {
      const left = o.swing === 'left';
      const side: XY = left ? [-n[0], -n[1]] : n;
      const off = left ? w.b : w.a;
      out.push({ kind: 'door', id: o.id, mark, base: [mid[0] + side[0] * off, mid[1] + side[1] * off], normal: side });
    } else {
      const outsideLeft = !inside([mid[0] + n[0] * (w.a + 3 * 32_512), mid[1] + n[1] * (w.a + 3 * 32_512)]);
      const side: XY = outsideLeft ? n : [-n[0], -n[1]];
      const off = outsideLeft ? w.a : w.b;
      out.push({ kind: 'window', id: o.id, mark, base: [mid[0] + side[0] * off, mid[1] + side[1] * off], normal: side });
    }
  }
  return out;
}

// ── notes ─────────────────────────────────────────────────────────────────────

/** A note (FS_annotation): its text anchored at `at` (the first line's left baseline), and a leader to a point. */
export interface Note {
  readonly id: string;
  readonly text: string;
  readonly at: XY;
  readonly leader: XY | null;
}

// ── paper ─────────────────────────────────────────────────────────────────────

export type AnnoFont = 'mono' | 'sans' | 'sans-medium';
export type Measure = (text: string, font: AnnoFont, size: number) => number;

/** The paper sizes a medium draws annotation at: PDF points, or screen and SVG pixels. */
export interface AnnoMetrics {
  /** Dimension text size. */
  readonly text: number;
  /** The first exterior string's offset beyond everything drawn, and each next one's step. */
  readonly first: number;
  readonly step: number;
  /** An extra row of lengths that do not fit their span. */
  readonly row: number;
  /** Extension lines: their gap from the feature and how far they run past the string. */
  readonly gap: number;
  readonly overshoot: number;
  /** Half a tick's length. */
  readonly tick: number;
  /** A tag's radius. */
  readonly tagR: number;
  /** A note's text size and its lines' spacing. */
  readonly note: number;
  /** An arrowhead's length. */
  readonly arrow: number;
}

export const PDF_METRICS: AnnoMetrics = { text: 6, first: 20, step: 14, row: 8, gap: 3, overshoot: 2.5, tick: 2.4, tagR: 5.4, note: 6.5, arrow: 4.5 };
export const SCREEN_METRICS: AnnoMetrics = { text: 11, first: 30, step: 22, row: 13, gap: 5, overshoot: 4, tick: 4, tagR: 9, note: 12, arrow: 8 };

export type AnnoOwner = string;

export type AnnoPrim =
  | { readonly t: 'line'; readonly role: 'dim' | 'ext' | 'tick' | 'leader'; readonly a: XY; readonly b: XY; readonly owner: AnnoOwner; readonly group: DimGroup | 'note' }
  | { readonly t: 'arrow'; readonly pts: readonly [XY, XY, XY]; readonly owner: AnnoOwner; readonly group: DimGroup | 'note' }
  | {
      readonly t: 'text';
      readonly role: 'dim' | 'note' | 'tag';
      /** The baseline's anchor point. */
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly size: number;
      readonly font: AnnoFont;
      readonly anchor: 'start' | 'middle' | 'end';
      /** Degrees, clockwise on the page (−90 reads bottom to top). */
      readonly rotate: number;
      readonly owner: AnnoOwner;
      readonly group: DimGroup | 'note' | 'tag';
    }
  | { readonly t: 'tag'; readonly kind: 'door' | 'window'; readonly cx: number; readonly cy: number; readonly r: number; readonly owner: AnnoOwner };

/** Model → paper (y down), and paper units per base unit. */
export interface AnnoFrame {
  readonly P: (p: XY) => XY;
  readonly k: number;
}

/** An angle to two decimals, never −0. */
const tidy = (deg: number): number => {
  const r = Math.round(deg * 100) / 100;
  return r === 0 ? 0 : r;
};

/** Cap height of a face, as a fraction of its size. */
const CAP = 0.72;

/** Each exterior side's paper depth: how far its strings reach beyond everything drawn. */
export type SideDepths = Readonly<Record<Side, number>>;

/** Text placed along a string: its span's centre, and where it goes. */
interface Placed {
  readonly centre: number;
  readonly width: number;
  readonly row: number;
  readonly at: number;
}

/**
 * Where a string's lengths go along it (paper units from its start): centred in its span where
 * it fits, else on the next row out, packed left to right without overlap.
 */
function placeLabels(spans: readonly { a: number; b: number; w: number }[], pad: number): Placed[] {
  const out: Placed[] = [];
  const fits = spans.map((s) => s.w + pad <= s.b - s.a);
  // Row 0: those that fit their span, centred in it.
  const row1: number[] = [];
  spans.forEach((s, i) => {
    const c = (s.a + s.b) / 2;
    if (fits[i]) out[i] = { centre: c, width: s.w, row: 0, at: c };
    else row1.push(i);
  });
  // Row 1, packed: each as near its span's centre as the one before it allows.
  let lastEnd = -Infinity;
  const placed: number[] = [];
  for (const i of row1) {
    const s = spans[i]!;
    const c = (s.a + s.b) / 2;
    const start = Math.max(c - s.w / 2, lastEnd + pad);
    out[i] = { centre: c, width: s.w, row: 1, at: start + s.w / 2 };
    lastEnd = start + s.w;
    placed.push(i);
  }
  // Pull a packed run back left where it was pushed past its spans, as far as the one before allows.
  for (let j = placed.length - 1; j > 0; j--) {
    const i = placed[j]!;
    const prev = placed[j - 1]!;
    const want = out[i]!.centre;
    const minAt = out[prev]!.at + out[prev]!.width / 2 + pad + out[i]!.width / 2;
    if (out[i]!.at > want && minAt < out[i]!.at) out[i] = { ...out[i]!, at: Math.max(want, minAt) };
  }
  return out;
}

/** Everything one string draws, given where its line is on paper. */
function drawString(s: DimString, frame: AnnoFrame, m: AnnoMetrics, measure: Measure, format: (bu: number) => string, offset: number, out: AnnoPrim[]): number {
  const { P } = frame;
  const at = (along: number): XY => [s.origin[0] + s.u[0] * along, s.origin[1] + s.u[1] * along];
  // Paper direction of u and n (y flips).
  const pu: XY = [s.u[0], -s.u[1]];
  const pn: XY = [s.n[0], -s.n[1]];
  const line = (along: number): XY => {
    const p = P(at(along));
    return [p[0] + pn[0] * offset, p[1] + pn[1] * offset];
  };
  const first = line(s.stops[0]!.along);
  const last = line(s.stops[s.stops.length - 1]!.along);
  const g = s.group;
  const runOn = s.extension ? m.tick * 1.6 : 0;
  out.push({ t: 'line', role: 'dim', a: [first[0] - pu[0] * runOn, first[1] - pu[1] * runOn], b: [last[0] + pu[0] * runOn, last[1] + pu[1] * runOn], owner: s.id, group: g });
  // Ticks: architectural slashes, 45° across the line.
  const slash: XY = [(pu[0] + pn[0]) / Math.SQRT2, (pu[1] + pn[1]) / Math.SQRT2];
  for (const st of s.stops) {
    const p = line(st.along);
    out.push({ t: 'line', role: 'tick', a: [p[0] - slash[0] * m.tick, p[1] - slash[1] * m.tick], b: [p[0] + slash[0] * m.tick, p[1] + slash[1] * m.tick], owner: s.id, group: g });
    if (!s.extension) continue;
    // Extension line: from a gap off the feature to just past the string, perpendicular to it.
    const f = P(st.feature);
    const d = (p[0] - f[0]) * pn[0] + (p[1] - f[1]) * pn[1];
    const sign = d >= 0 ? 1 : -1;
    if (Math.abs(d) <= m.gap) continue;
    const from: XY = [p[0] - pn[0] * (d - sign * m.gap), p[1] - pn[1] * (d - sign * m.gap)];
    out.push({ t: 'line', role: 'ext', a: from, b: [p[0] + pn[0] * sign * m.overshoot, p[1] + pn[1] * sign * m.overshoot], owner: s.id, group: g });
  }
  // Lengths: on the n side of the line, reading along u (left to right, or bottom to top).
  const rotate = (Math.atan2(pu[1], pu[0]) * 180) / Math.PI;
  const texts = s.lengths.map((l) => format(l));
  const spans = s.stops.slice(1).map((st, i) => {
    const a = (s.stops[i]!.along - s.stops[0]!.along) * frame.k;
    const b = (st.along - s.stops[0]!.along) * frame.k;
    return { a, b, w: measure(texts[i]!, 'mono', m.text) };
  });
  const placed = placeLabels(spans, m.text * 0.6);
  // The text's own up, on paper: for a rotation θ (clockwise), (sin θ, −cos θ).
  const up: XY = [Math.sin((rotate * Math.PI) / 180), -Math.cos((rotate * Math.PI) / 180)];
  let rows = 0;
  placed.forEach((p, i) => {
    rows = Math.max(rows, p.row);
    const lift = 2 + p.row * m.row;
    const base = [first[0] + pu[0] * p.at, first[1] + pu[1] * p.at] as XY;
    // The text's centre line sits `lift + cap/2` out along n; its baseline is half a cap below its centre.
    const out1 = lift + (m.text * CAP) / 2;
    const centre: XY = [base[0] + pn[0] * out1, base[1] + pn[1] * out1];
    const baseline: XY = [centre[0] - up[0] * ((m.text * CAP) / 2), centre[1] - up[1] * ((m.text * CAP) / 2)];
    out.push({ t: 'text', role: 'dim', x: baseline[0], y: baseline[1], text: texts[i]!, size: m.text, font: 'mono', anchor: 'middle', rotate: tidy(rotate), owner: s.id, group: g });
    // A length moved off its span: a leader from it back to its span.
    if (p.row > 0) {
      const mid: XY = [first[0] + pu[0] * p.centre, first[1] + pu[1] * p.centre];
      const near: XY = [base[0] + pn[0] * (lift - 1), base[1] + pn[1] * (lift - 1)];
      out.push({ t: 'line', role: 'leader', a: [mid[0] + pn[0] * 1, mid[1] + pn[1] * 1], b: near, owner: s.id, group: g });
    }
  });
  return rows;
}

/** The annotation of one level, laid out on paper. */
export interface AnnoInput {
  readonly strings: readonly DimString[];
  readonly tags?: readonly Tag[];
  readonly notes?: readonly Note[];
}

export interface AnnoLayout {
  readonly prims: readonly AnnoPrim[];
  /** How far each side's exterior strings reach beyond the extent, paper units (0 for a side with none). */
  readonly depth: SideDepths;
}

/**
 * Lay out a level's annotation on paper. Exterior strings stack outward from the extent at
 * `first`, then `step` apart, each also moved out by the extra rows the ones inside it took;
 * interior and custom strings are drawn where they are; tags off their faces; notes at their text,
 * with a leader and an arrowhead to the point they are about.
 */
export function layoutAnnotations(input: AnnoInput, frame: AnnoFrame, m: AnnoMetrics, measure: Measure, format: (bu: number) => string): AnnoLayout {
  const prims: AnnoPrim[] = [];
  const depth: Record<Side, number> = { N: 0, S: 0, E: 0, W: 0 };
  for (const side of SIDES) {
    const list = input.strings.filter((s) => s.group === 'exterior' && s.side === side && s.local !== true).sort((a, b) => a.tier - b.tier);
    let off = m.first;
    for (const s of list) {
      const rows = drawString(s, frame, m, measure, format, off, prims);
      depth[side] = off + 2 + (rows + 1) * m.row;
      off += m.step + rows * m.row;
    }
  }
  for (const s of input.strings) if (s.local === true) drawString(s, frame, m, measure, format, m.first * 0.7, prims);
  for (const s of input.strings) if (s.group === 'custom') drawString(s, frame, m, measure, format, 0, prims);
  for (const t of input.tags ?? []) {
    const b = frame.P(t.base);
    const r = t.kind === 'door' ? m.tagR * 0.95 : m.tagR;
    const cx = b[0] + t.normal[0] * (r + m.gap);
    const cy = b[1] - t.normal[1] * (r + m.gap);
    prims.push({ t: 'tag', kind: t.kind, cx, cy, r, owner: t.id });
    const size = t.mark.length > 2 ? m.tagR * 0.78 : m.tagR * 0.92;
    prims.push({ t: 'text', role: 'tag', x: cx, y: cy + size * CAP * 0.5, text: t.mark, size, font: 'sans-medium', anchor: 'middle', rotate: 0, owner: t.id, group: 'tag' });
  }
  for (const n of input.notes ?? []) notePrims(n, frame, m, measure, prims);
  // Room strings last, and only where their lengths meet no other text: the person's own strings,
  // notes and tags win, and a room string that would print over one is left out.
  const placed = prims.filter((p): p is Extract<AnnoPrim, { t: 'text' }> => p.t === 'text').map((t) => textBox(t, measure));
  for (const s of input.strings) {
    if (s.group !== 'interior') continue;
    const mine: AnnoPrim[] = [];
    drawString(s, frame, m, measure, format, 0, mine);
    const boxes = mine.filter((p): p is Extract<AnnoPrim, { t: 'text' }> => p.t === 'text').map((t) => textBox(t, measure));
    if (boxes.some((b) => placed.some((q) => overlaps(b, q)))) continue;
    prims.push(...mine);
    placed.push(...boxes);
  }
  return { prims, depth };
}

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The paper box a text covers (level or turned a quarter), a little padded. */
function textBox(t: Extract<AnnoPrim, { t: 'text' }>, measure: Measure): Box {
  const w = measure(t.text, t.font, t.size);
  const h = t.size * CAP;
  const x0 = t.anchor === 'middle' ? -w / 2 : t.anchor === 'end' ? -w : 0;
  const pad = 1.5;
  if (Math.abs(t.rotate) < 45) return { x0: t.x + x0 - pad, x1: t.x + x0 + w + pad, y0: t.y - h - pad, y1: t.y + pad };
  // Turned a quarter: the text runs up (or down) the page.
  return { x0: t.x - h - pad, x1: t.x + pad, y0: t.y - x0 - w - pad, y1: t.y - x0 + pad };
}

const overlaps = (a: Box, b: Box): boolean => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

/** A note: its lines from `at` down, and a leader from the nearer end of its first line to the point, with an arrowhead. */
function notePrims(n: Note, frame: AnnoFrame, m: AnnoMetrics, measure: Measure, out: AnnoPrim[]): void {
  const [x, y] = frame.P(n.at);
  const lines = n.text.split('\n');
  const lh = m.note * 1.3;
  let w = 0;
  lines.forEach((l, i) => {
    w = Math.max(w, measure(l, 'sans', m.note));
    out.push({ t: 'text', role: 'note', x, y: y + i * lh, text: l, size: m.note, font: 'sans', anchor: 'start', rotate: 0, owner: n.id, group: 'note' });
  });
  if (n.leader === null) return;
  const tip = frame.P(n.leader);
  const midY = y - (m.note * CAP) / 2;
  const top = y - m.note * CAP - m.gap;
  const bottom = y + (lines.length - 1) * lh + m.note * 0.3 + m.gap;
  let shoulder: XY;
  if (tip[0] >= x && tip[0] <= x + w && (tip[1] > bottom || tip[1] < top)) {
    // Straight above or below the text: from its edge, at the point nearest the tip.
    shoulder = [tip[0], tip[1] > bottom ? bottom : top];
  } else {
    // Beside it: a short shoulder level with its first line, from the side the tip is on.
    const left = tip[0] < x + w / 2;
    const from: XY = left ? [x - m.gap, midY] : [x + w + m.gap, midY];
    shoulder = [from[0] + (left ? -m.arrow : m.arrow), from[1]];
    out.push({ t: 'line', role: 'leader', a: from, b: shoulder, owner: n.id, group: 'note' });
  }
  out.push({ t: 'line', role: 'leader', a: shoulder, b: tip, owner: n.id, group: 'note' });
  const dx = tip[0] - shoulder[0];
  const dy = tip[1] - shoulder[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const L = m.arrow;
  out.push({ t: 'arrow', pts: [tip, [tip[0] - ux * L - uy * L * 0.35, tip[1] - uy * L + ux * L * 0.35], [tip[0] - ux * L + uy * L * 0.35, tip[1] - uy * L - ux * L * 0.35]], owner: n.id, group: 'note' });
}

/** The bounding box of a note's text on paper, for hit-testing and selection. */
export function noteBox(n: Note, frame: AnnoFrame, m: AnnoMetrics, measure: Measure): { x: number; y: number; w: number; h: number } {
  const [x, y] = frame.P(n.at);
  const lines = n.text.split('\n');
  const w = Math.max(...lines.map((l) => measure(l, 'sans', m.note)));
  const top = y - m.note * CAP - 2;
  return { x: x - 2, y: top, w: w + 4, h: (lines.length - 1) * m.note * 1.3 + m.note * CAP + 4 + m.note * 0.25 };
}

// ── measures ──────────────────────────────────────────────────────────────────

/**
 * Text widths without a font file: JetBrains Mono's advance is 0.6 em; Inter is approximated per
 * character class. Good enough to keep text apart; the PDF measures with its embedded fonts.
 */
export const approxMeasure: Measure = (text, font, size) => {
  if (font === 'mono') return text.length * 0.6 * size;
  let w = 0;
  for (const ch of text) w += /[il.,:;'|!]/.test(ch) ? 0.28 : /[mwMW@]/.test(ch) ? 0.84 : /[A-Z0-9]/.test(ch) ? 0.66 : ch === ' ' ? 0.28 : 0.54;
  return w * size * (font === 'sans-medium' ? 1.03 : 1);
};

// ── scale bar ─────────────────────────────────────────────────────────────────

/** A graphic scale: alternate filled and open boxes at 0, ¼, ½ and the whole, and their labels. */
export interface ScaleBar {
  /** Paper lengths from the bar's start. */
  readonly ticks: readonly number[];
  readonly labels: readonly string[];
  readonly width: number;
}

/**
 * The scale bar for `k` paper units per base unit: the smallest of 4, 8, 16, 32, 64 ft (or 1, 2, 5,
 * 10, 20, 50 m) that is at least `min` paper units long.
 */
export function scaleBarOf(k: number, metric: boolean, min: number): ScaleBar {
  const steps = metric
    ? [1, 2, 5, 10, 20, 50].map((v) => ({ total: v * 1_280_000, label: (x: number) => `${String(x / 1_280_000)} m` }))
    : [4, 8, 16, 32, 64].map((v) => ({ total: v * 390_144, label: (x: number) => `${String(x / 390_144)}'` }));
  const pick = steps.find((s) => s.total * k >= min) ?? steps[steps.length - 1]!;
  const values = [0, 0.25, 0.5, 1].map((f) => f * pick.total);
  return { ticks: values.map((v) => v * k), labels: values.map((v, i) => (i === 1 ? '' : pick.label(v))), width: pick.total * k };
}

// ── from a scene ──────────────────────────────────────────────────────────────

/**
 * A render2d scene as dimensioning reads it. `rooms` gives each room's title and label point as
 * the caller draws its label; a room it leaves out is labelled at its polygon's middle.
 */
export function annoSourceOf(scene: Scene, rooms?: ReadonlyMap<string, { readonly title: string; readonly label: XY }>): AnnoSource {
  return {
    walls: [...scene.walls.values()].map((w) => ({ id: w.id, outline: w.outline, start: w.start, end: w.end, a: w.a, b: w.b, arc: w.sagitta !== undefined })),
    fills: [...scene.fills.values()],
    openings: [...scene.openings.values()].map((o) => ({ id: o.id, wall: o.wall, kind: o.kind, start: o.start, end: o.end, swing: o.swing })),
    rooms: [...scene.rooms.values()].map((r) => {
      const given = rooms?.get(r.id);
      if (given !== undefined) return { id: r.id, title: given.title, outer: r.outer, holes: r.holes, label: given.label };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of r.outer) [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
      return { id: r.id, title: r.name ?? r.function, outer: r.outer, holes: r.holes, label: [(minX + maxX) / 2, (minY + maxY) / 2] as XY };
    }),
  };
}
