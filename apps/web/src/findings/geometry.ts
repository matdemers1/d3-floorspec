import type { Finding, Severity, Target } from './types';
import { findingKey } from './model';

/**
 * Where a finding is drawn on the plan (FLR-T-6.9, FLR-REQ-102).
 *
 * The report gives each finding's `location` (Rules 9.4): its level and shapes — the subject's, each
 * candidate's, then each involved element's, in that order — so a finding about a panel draws the
 * panel, its working space and what stands in it. This file names each shape (a room, a clearance
 * zone, an opening, an element in the way) so the canvas can draw each as what it is.
 *
 * Receptacle spacing has no shape of its own: the report measures it along the room's wall line
 * (Rules 8.1–8.2) and draws the room. Here the wall line is approximated for display — the room's
 * polygon walked once around, broken at doorways — with the counted receptacles placed on it, and
 * the parts of it that are farther from a receptacle than the rule allows are drawn along the walls.
 * That is a picture, not a measure: the measured value and the threshold are the report's, exactly.
 */

export type Pt = readonly [number, number];

export type OverlayKind = 'room' | 'zone' | 'opening' | 'element' | 'involved';

export interface OverlayShape {
  kind: OverlayKind;
  /** Polygon rings (outer first, then holes), or a polyline. */
  rings?: Pt[][];
  line?: Pt[];
}

export interface SpacingRun {
  /** The run along the wall line, as a polyline in plan coordinates. */
  line: Pt[];
  /** Its length, base units (display only). */
  length: number;
}

export interface FindingOverlay {
  key: string;
  severity: Severity;
  level: string;
  shapes: OverlayShape[];
  /** For a receptacle-spacing finding: the parts of the wall line beyond the rule's reach. */
  spacing: SpacingRun[];
  /** Where a label goes: the subject's shape's centre. */
  anchor: Pt | null;
}

const hasShape = (t: Target) => t.kind === 'room' || t.kind === 'opening' || t.kind === 'element' || t.kind === 'envelope';

const kindOfTarget = (t: Target): OverlayKind => (t.kind === 'room' ? 'room' : t.kind === 'envelope' ? 'zone' : t.kind === 'opening' ? 'opening' : 'element');

/** Each shape of a finding's location, named for what it is (Rules 9.4's order). */
export function namedShapes(f: Finding): OverlayShape[] {
  const targets = [f.subject, ...(f.candidates ?? [])].filter(hasShape);
  return f.location.shapes.map((s, i) => {
    const target = targets[i];
    const kind: OverlayKind = target === undefined ? 'involved' : kindOfTarget(target);
    return s.kind === 'segment' ? { kind: target === undefined ? 'involved' : kind, line: [s.points[0], s.points[1]] } : { kind, rings: [s.outer, ...s.holes] };
  });
}

/** The centre of a polygon's outer ring (area-weighted), or of a polyline's ends. */
export function centreOf(shape: OverlayShape): Pt | null {
  const ring = shape.rings?.[0];
  if (ring !== undefined && ring.length > 2) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i] as Pt;
      const q = ring[(i + 1) % ring.length] as Pt;
      const cross = p[0] * q[1] - q[0] * p[1];
      a += cross;
      cx += (p[0] + q[0]) * cross;
      cy += (p[1] + q[1]) * cross;
    }
    if (a !== 0) return [cx / (3 * a), cy / (3 * a)];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  const line = shape.line;
  if (line !== undefined && line.length > 0) {
    const a = line[0] as Pt;
    const b = line[line.length - 1] as Pt;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return null;
}

// ─── The wall line, for receptacle spacing ───────────────────────────────────────────────────

export interface RingPath {
  /** The ring's points, closed: the last is the first again. */
  readonly pts: Pt[];
  /** Cumulative length at each point. */
  readonly cum: number[];
  readonly total: number;
}

export function ringPath(ring: readonly Pt[]): RingPath {
  const pts = [...ring, ring[0] as Pt];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, cum, total: cum[cum.length - 1] as number };
}

/** The position along the ring nearest `p`, and how far `p` is from it. */
export function locate(path: RingPath, p: Pt): { t: number; distance: number } {
  let best = { t: 0, distance: Infinity };
  for (let i = 1; i < path.pts.length; i++) {
    const a = path.pts[i - 1] as Pt;
    const b = path.pts[i] as Pt;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const d = Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1]);
    if (d < best.distance) best = { t: (path.cum[i - 1] as number) + u * Math.sqrt(len2), distance: d };
  }
  return best;
}

const mod = (t: number, n: number) => ((t % n) + n) % n;

export function pointAt(path: RingPath, t: number): Pt {
  const s = mod(t, path.total);
  let i = 1;
  while (i < path.cum.length - 1 && (path.cum[i] as number) < s) i++;
  const a = path.pts[i - 1] as Pt;
  const b = path.pts[i] as Pt;
  const c0 = path.cum[i - 1] as number;
  const len = (path.cum[i] as number) - c0;
  const u = len === 0 ? 0 : (s - c0) / len;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/** The part of the ring from `t0` to `t1` (increasing; `t1` may pass the end and wrap), as a polyline. */
export function slice(path: RingPath, t0: number, t1: number): Pt[] {
  const out: Pt[] = [pointAt(path, t0)];
  // Every corner strictly between t0 and t1, over as many turns as the span needs.
  for (let turn = Math.floor(t0 / path.total) * path.total; turn < t1; turn += path.total) {
    for (let i = 0; i < path.cum.length - 1; i++) {
      const at = turn + (path.cum[i] as number);
      if (at > t0 && at < t1) out.push(path.pts[i] as Pt);
    }
  }
  out.push(pointAt(path, t1));
  return out;
}

/** A doorway's interval on the ring: the shorter arc between its two ends. */
export function breakOf(path: RingPath, a: Pt, b: Pt): [number, number] {
  const ta = locate(path, a).t;
  const tb = locate(path, b).t;
  const [lo, hi] = ta <= tb ? [ta, tb] : [tb, ta];
  return hi - lo <= path.total / 2 ? [lo, hi] : [hi, lo + path.total];
}

export interface Stretch {
  start: number;
  length: number;
  /** A wall line with no break is one closed stretch: it has no ends (Rules 8.1). */
  closed: boolean;
}

/** The stretches of a wall line: the ring less its breaks (merged), in order. */
export function stretchesOf(path: RingPath, breaks: readonly [number, number][]): Stretch[] {
  if (breaks.length === 0) return [{ start: 0, length: path.total, closed: true }];
  // Normalise to [start, end) with start in [0, total), then merge on the circle.
  const spans = breaks.map(([s, e]) => [mod(s, path.total), mod(s, path.total) + (e - s)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  // A last span that wraps past the first one's start swallows it.
  while (merged.length > 1) {
    const first = merged[0] as [number, number];
    const last = merged[merged.length - 1] as [number, number];
    if (last[1] - path.total < first[0]) break;
    last[1] = Math.max(last[1], first[1] + path.total);
    merged.shift();
  }
  const out: Stretch[] = [];
  for (let i = 0; i < merged.length; i++) {
    const end = (merged[i] as [number, number])[1];
    const next = merged[(i + 1) % merged.length] as [number, number];
    const nextStart = i + 1 < merged.length ? next[0] : next[0] + path.total;
    if (nextStart - end > 1e-6) out.push({ start: mod(end, path.total), length: nextStart - end, closed: false });
  }
  return out;
}

export type SpacingMeasure = 'receptacleReach' | 'wallRunBetweenReceptacles';

/**
 * The parts of the wall line beyond what a rule allows, as parameter spans on the ring:
 *   - `wallRunBetweenReceptacles` ≤ T: each run with no receptacle in it longer than T, whole;
 *   - `receptacleReach` ≤ T: each part farther than T from the nearest receptacle, within its stretch.
 * `receptacles` are positions on the ring.
 */
export function spacingSpans(path: RingPath, stretches: readonly Stretch[], receptacles: readonly number[], measure: SpacingMeasure, threshold: number): [number, number][] {
  const out: [number, number][] = [];
  for (const s of stretches) {
    const inside = receptacles
      .map((r) => mod(r - s.start, path.total))
      .filter((r) => r <= s.length + 1e-6)
      .sort((a, b) => a - b);
    // Gaps as [from, to] along the stretch, with whether each end is a receptacle.
    const gaps: { from: number; to: number; a: boolean; b: boolean }[] = [];
    if (inside.length === 0) gaps.push({ from: 0, to: s.length, a: false, b: false });
    else {
      if (!s.closed) gaps.push({ from: 0, to: inside[0] as number, a: false, b: true });
      for (let i = 1; i < inside.length; i++) gaps.push({ from: inside[i - 1] as number, to: inside[i] as number, a: true, b: true });
      if (s.closed) gaps.push({ from: inside[inside.length - 1] as number, to: (inside[0] as number) + s.length, a: true, b: true });
      else gaps.push({ from: inside[inside.length - 1] as number, to: s.length, a: true, b: false });
    }
    for (const g of gaps) {
      const len = g.to - g.from;
      if (len <= 0) continue;
      if (measure === 'wallRunBetweenReceptacles') {
        if (len > threshold) out.push([s.start + g.from, s.start + g.to]);
        continue;
      }
      // Reach: within T of a receptacle end is reached; no receptacle at all reaches nothing.
      const from = g.a ? g.from + threshold : g.from;
      const to = g.b ? g.to - threshold : g.to;
      if (inside.length === 0) out.push([s.start + g.from, s.start + g.to]);
      else if (to - from > 1e-6) out.push([s.start + from, s.start + to]);
    }
  }
  return out;
}

/** What the canvas knows of a level, enough to draw receptacle spacing. */
export interface LevelLike {
  rooms: readonly { id: string; outer: readonly Pt[] }[];
  openings: readonly { id: string; wall: string; kind: 'door' | 'window' | 'opening'; start: Pt; end: Pt }[];
  walls: readonly { id: string; thickness: number }[];
  devices: readonly { id: string; placement: { point: Pt } | null }[];
}

const SPACING: readonly string[] = ['receptacleReach', 'wallRunBetweenReceptacles'];

/** The receptacle-spacing runs of a finding, drawn along its room's wall line; none for another finding. */
export function spacingRuns(f: Finding, level: LevelLike): SpacingRun[] {
  const out: SpacingRun[] = [];
  for (const m of f.measures) {
    if (m.holds || !SPACING.includes(m.measure) || m.target.kind !== 'room' || typeof m.threshold !== 'number') continue;
    const roomId = m.target.id;
    const room = level.rooms.find((r) => r.id === roomId);
    if (room === undefined || room.outer.length < 3) continue;
    const path = ringPath(room.outer);
    const thickness = new Map(level.walls.map((w) => [w.id, w.thickness]));
    // Doorways on this room's walls: a door, or an opening with no fill (Core 11.4).
    const breaks = level.openings
      .filter((o) => o.kind !== 'window')
      .filter((o) => {
        const tol = (thickness.get(o.wall) ?? 0) * 0.6 + 32_512;
        return locate(path, o.start).distance <= tol && locate(path, o.end).distance <= tol;
      })
      .map((o) => breakOf(path, o.start, o.end));
    const stretches = stretchesOf(path, breaks);
    const counted = new Set(m.involved ?? []);
    const receptacles = level.devices.flatMap((d) => (counted.has(d.id) && d.placement !== null ? [locate(path, d.placement.point).t] : []));
    for (const [t0, t1] of spacingSpans(path, stretches, receptacles, m.measure as SpacingMeasure, m.threshold)) out.push({ line: slice(path, t0, t1), length: t1 - t0 });
  }
  return out;
}

/** Everything the canvas draws for a finding on a level. */
export function overlayOf(f: Finding, level: LevelLike | null): FindingOverlay {
  const shapes = namedShapes(f);
  const subject = shapes[0];
  return {
    key: findingKey(f),
    severity: f.severity,
    level: f.location.level,
    shapes,
    spacing: level === null ? [] : spacingRuns(f, level),
    anchor: subject === undefined ? null : centreOf(subject),
  };
}

/** The bounds of a finding's drawing, to zoom the plan to it. */
export function boundsOfOverlay(o: FindingOverlay): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pts: Pt[] = [...o.shapes.flatMap((s) => [...(s.rings?.flat() ?? []), ...(s.line ?? [])]), ...o.spacing.flatMap((r) => r.line)];
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
