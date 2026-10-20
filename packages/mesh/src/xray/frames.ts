/**
 * Walls as X-ray reads them (FLR-T-14.5): each wall's frame on the plan — its location line from its
 * start junction, the unit vector along it and the one to its left — where its faces stand across
 * it, where each layer runs along it, and its openings in that frame.
 *
 * Arithmetic is IEEE double over the engine's integers: + − × ÷ and `Math.sqrt`, which every engine
 * rounds the same way — never `Math.hypot` or the trigonometric functions, which may differ between
 * Node and a browser. So the same document gives the same bytes everywhere.
 */
import { get } from '../own.js';
import type { Derived, FloorspecDocument, Layer } from '@floorspec/engine';

/** One inch, base units (25.4 mm × 1280): an integer. */
export const INCH = 32512;

export type V2 = readonly [number, number];

/** A wall's frame: `S` its start junction, `u` along it, `n` to its left, `L` its length (its chord, for an arc wall). */
export interface WallFrame {
  readonly id: string;
  readonly level: string;
  readonly S: V2;
  readonly u: V2;
  readonly n: V2;
  readonly L: number;
  readonly start: string;
  readonly end: string;
  readonly arc: boolean;
  /** The left and right faces' offsets from the location line, along `n` (left ≥ right). */
  readonly left: number;
  readonly right: number;
  /** Where each face starts and ends along `u` (the derived face ends, 5.7). */
  readonly leftRange: V2;
  readonly rightRange: V2;
  readonly base: number;
  readonly top: number;
  /** Its effective layers (5.4), left face first. */
  readonly layers: readonly Layer[];
  /** The offset of the middle of its core (its first core layer, else its thickest): where what runs in it runs. */
  readonly core: number;
}

/** An opening in its wall's frame: from `t0` to `t1` along it, from `sill` to `head`. */
export interface FrameOpening {
  readonly id: string;
  readonly t0: number;
  readonly t1: number;
  readonly sill: number;
  readonly head: number;
}

const sub = (p: V2, q: V2): V2 => [p[0] - q[0], p[1] - q[1]];
export const dot = (p: V2, q: V2): number => p[0] * q[0] + p[1] * q[1];

/** A wall's effective layers (5.4): its own, else its type's. */
export function effectiveLayers(doc: FloorspecDocument, wall: { type?: string; layers?: Layer[] }): readonly Layer[] {
  if (wall.layers !== undefined) return wall.layers;
  const t = wall.type === undefined ? undefined : get(doc.types, wall.type);
  return t?.kind === 'wallType' ? t.layers : [];
}

/** The offsets of each layer's two faces along `n`: layer i from `hi` (towards the left face) to `lo`. */
export function layerOffsets(left: number, layers: readonly Layer[]): { lo: number; hi: number }[] {
  let at = left;
  return layers.map((l) => {
    const hi = at;
    at -= l.thickness;
    return { lo: at, hi };
  });
}

/** Every wall's frame, by ID: straight walls on their location line, arc walls on their chord. */
export function wallFrames(doc: FloorspecDocument, derived: Derived): Map<string, WallFrame> {
  const out = new Map<string, WallFrame>();
  for (const id of Object.keys(derived.walls).sort()) {
    const w = get(doc.walls, id);
    const d = derived.walls[id]!;
    if (w === undefined) continue;
    const a = get(doc.junctions, w.start)?.position;
    const b = get(doc.junctions, w.end)?.position;
    if (a === undefined || b === undefined) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.sqrt(dx * dx + dy * dy);
    if (!(L > 0)) continue;
    const S: V2 = [a[0], a[1]];
    const u: V2 = [dx / L, dy / L];
    const n: V2 = [-u[1], u[0]];
    const left = dot(sub(d.startLeft, S), n);
    const right = dot(sub(d.startRight, S), n);
    const layers = effectiveLayers(doc, w);
    const offsets = layerOffsets(left, layers);
    let core = layers.findIndex((l) => l.function === 'core');
    if (core < 0) core = layers.reduce((best, l, i) => (l.thickness > layers[best]!.thickness ? i : best), 0);
    const o = offsets[core];
    out.set(id, {
      id,
      level: w.level,
      S,
      u,
      n,
      L,
      start: w.start,
      end: w.end,
      arc: w.arc !== undefined && (d.polyline?.length ?? 0) > 2,
      left,
      right,
      leftRange: [dot(sub(d.startLeft, S), u), dot(sub(d.endLeft, S), u)],
      rightRange: [dot(sub(d.startRight, S), u), dot(sub(d.endRight, S), u)],
      base: d.baseElevation,
      top: d.topElevation,
      layers,
      core: o === undefined ? (left + right) / 2 : (o.lo + o.hi) / 2,
    });
  }
  return out;
}

/** Where a slice of the wall at offset `o` across it starts and ends along it: between its faces' ends. */
export function alongAt(f: WallFrame, o: number): V2 {
  const k = f.left === f.right ? 0 : (f.left - o) / (f.left - f.right);
  return [f.leftRange[0] + k * (f.rightRange[0] - f.leftRange[0]), f.leftRange[1] + k * (f.rightRange[1] - f.leftRange[1])];
}

/** A point of the plan at `t` along the wall and `o` across it. */
export const planAt = (f: WallFrame, t: number, o: number): V2 => [f.S[0] + t * f.u[0] + o * f.n[0], f.S[1] + t * f.u[1] + o * f.n[1]];

/** How far along the wall a point of the plan is (its projection on the location line). */
export const alongOf = (f: WallFrame, p: V2): number => dot(sub(p, f.S), f.u);

/** The openings in a wall, in its frame, sorted along it; each clamped to the wall's height. */
export function openingsOf(doc: FloorspecDocument, derived: Derived, f: WallFrame): FrameOpening[] {
  const out: FrameOpening[] = [];
  for (const id of Object.keys(derived.openings).sort()) {
    const o = get(doc.openings, id);
    if (o?.wall !== f.id) continue;
    const d = derived.openings[id]!;
    const ta = alongOf(f, d.start);
    const tb = alongOf(f, d.end);
    const sill = Math.max(f.base, d.sillElevation);
    const head = Math.min(f.top, d.headElevation);
    if (head <= sill) continue;
    out.push({ id, t0: Math.min(ta, tb), t1: Math.max(ta, tb), sill, head });
  }
  return out.sort((p, q) => p.t0 - q.t0 || (p.id < q.id ? -1 : 1));
}

/** A rectangle on a wall's elevation: `t` along it, `z` up. */
export interface Rect {
  readonly t0: number;
  readonly t1: number;
  readonly z0: number;
  readonly z1: number;
}

/** [lo, hi] less every interval in `cuts`: what is left, in order. */
function remaining(lo: number, hi: number, cuts: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...cuts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out: [number, number][] = [];
  let at = lo;
  for (const [a, b] of sorted) {
    if (b <= at) continue;
    if (a >= hi) break;
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
    if (at >= hi) break;
  }
  if (at < hi) out.push([at, hi]);
  return out;
}

/**
 * A rectangle of the elevation less `holes`, as rectangles: cut into strips at every hole's edges,
 * each strip's free heights, and neighbouring strips with the same free heights joined again.
 */
export function cells(area: Rect, holes: readonly Rect[]): Rect[] {
  const inside = holes.filter((h) => h.t1 > area.t0 && h.t0 < area.t1 && h.z1 > area.z0 && h.z0 < area.z1);
  const xs = [...new Set([area.t0, area.t1, ...inside.flatMap((h) => [h.t0, h.t1]).filter((t) => t > area.t0 && t < area.t1)])].sort((p, q) => p - q);
  const out: Rect[] = [];
  let run: { t0: number; t1: number; free: [number, number][] } | null = null;
  const flush = () => {
    if (run !== null) for (const [z0, z1] of run.free) out.push({ t0: run.t0, t1: run.t1, z0, z1 });
  };
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]!;
    const b = xs[i + 1]!;
    const over = inside.filter((h) => h.t0 <= a && h.t1 >= b).map((h) => [h.z0, h.z1] as const);
    const free = remaining(area.z0, area.z1, over);
    const same = run !== null && run.free.length === free.length && run.free.every((f, k) => f[0] === free[k]![0] && f[1] === free[k]![1]);
    if (same) run!.t1 = b;
    else {
      flush();
      run = { t0: a, t1: b, free };
    }
  }
  flush();
  return out;
}
