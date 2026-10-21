/**
 * The heat-loss map in 3D (FLR-T-16.4, the board's "16.4 · Heat-loss map in 3D"): the envelope's surfaces
 * — its walls' faces, its windows and doors, its roofs' faces — as one untextured mesh whose every
 * vertex carries the band of its surface's loss (low, typical, raised, high; @floorspec/analysis decides
 * the bands). A view colours the bands from its theme with vertex colours: one draw call, no texture
 * unit taken from the 16 a view's lamps and maps share (the materials suite's budget).
 *
 * Each surface is laid just outside what it colours — a wall's two faces 6 mm out, an opening 12 mm out
 * of both faces, a roof's faces 12 mm up — so it shows over the house drawn beneath, and is never
 * picked. Pure and deterministic: data in, typed arrays out.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import type { Vec3 } from './types.js';

const UNITS_PER_METRE = 1_280_000;
/** How far out of its surface each kind is laid, base units. */
const WALL_OUT = 6 * 1280;
const OPENING_OUT = 12 * 1280;
const ROOF_UP = 12 * 1280;

export const LOSS_BANDS = ['low', 'typical', 'raised', 'high'] as const;
export type HeatLossBand = (typeof LOSS_BANDS)[number];

/** A surface to draw: an element and its band. */
export interface HeatLossSurface {
  readonly element: string;
  readonly kind: 'wall' | 'window' | 'door' | 'roof';
  readonly band: HeatLossBand;
}

export interface HeatLossMesh {
  /** Float32 metres relative to the origin, three per vertex, three vertices per triangle. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Each vertex's band, an index into LOSS_BANDS. */
  readonly bands: Uint8Array;
  /** Each triangle's element, for a hover. */
  readonly elements: readonly string[];
  /** Each triangle's level. */
  readonly levels: readonly string[];
}

type P2 = readonly [number, number];
type P3 = readonly [number, number, number];

class Sink {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly b: number[] = [];
  readonly e: string[] = [];
  readonly l: string[] = [];
  tri(a: P3, b: P3, c: P3, band: number, element: string, level: string): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) return;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const v of [a, b, c]) {
      this.p.push(v[0], v[1], v[2]);
      this.n.push(nx, ny, nz);
      this.b.push(band);
    }
    this.e.push(element);
    this.l.push(level);
  }
  quad(a: P3, b: P3, c: P3, d: P3, band: number, element: string, level: string): void {
    this.tri(a, b, c, band, element, level);
    this.tri(a, c, d, band, element, level);
  }
}

/** A polyline offset `by` to its left (positive) or right, in plan. */
function offsetLine(points: readonly P2[], by: number): P2[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / len) * by, p[1] + (dx / len) * by];
  });
}

/** A vertical strip along a polyline between two elevations, both sides facing out. */
function strip(s: Sink, line: readonly P2[], z0: number, z1: number, band: number, element: string, level: string, flip: boolean): void {
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const q: [P3, P3, P3, P3] = [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]];
    if (flip) s.quad(q[1], q[0], q[3], q[2], band, element, level);
    else s.quad(q[0], q[1], q[2], q[3], band, element, level);
  }
}

/** Ear-clipping of a simple polygon in plan, by index; counter-clockwise or clockwise. */
export function earClip(poly: readonly P2[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p: P2, a: P2, b: P2, c: P2) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const out: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!;
      const ib = idx[i]!;
      const ic = idx[(i + 1) % idx.length]!;
      const a = poly[ia]!, b = poly[ib]!, c = poly[ic]!;
      if (cross(a, b, c) <= 0) continue;
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inside(poly[j]!, a, b, c))) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0]!, idx[1]!, idx[2]!]);
  return out;
}

/**
 * The map's mesh: every surface of `surfaces` that the derivation draws — a wall's two faces (its whole
 * height, its openings left to their own surfaces), an opening's rectangle on both faces of its wall, a
 * roof's derived faces. Walls with no derived geometry, and roofs with no derived surface, are left out.
 */
export function heatLossMesh(doc: FloorspecDocument, derived: Derived, surfaces: readonly HeatLossSurface[], origin: Vec3 = [0, 0, 0]): HeatLossMesh {
  const s = new Sink();
  const sorted = [...surfaces].sort((a, b) => (a.kind === b.kind ? (a.element < b.element ? -1 : a.element > b.element ? 1 : 0) : a.kind < b.kind ? -1 : 1));
  for (const x of sorted) {
    const band = LOSS_BANDS.indexOf(x.band);
    if (x.kind === 'wall') {
      const d = derived.walls[x.element];
      const w = doc.walls?.[x.element];
      if (!d || !w) continue;
      const left: P2[] = d.left ?? [d.startLeft, d.endLeft];
      const right: P2[] = d.right ?? [d.startRight, d.endRight];
      strip(s, offsetLine(left, WALL_OUT), d.baseElevation, d.topElevation, band, x.element, w.level, false);
      strip(s, offsetLine(right, -WALL_OUT), d.baseElevation, d.topElevation, band, x.element, w.level, true);
    } else if (x.kind === 'window' || x.kind === 'door') {
      const o = derived.openings[x.element];
      const host = doc.openings?.[x.element];
      const d = host === undefined ? undefined : derived.walls[host.wall];
      const w = host === undefined ? undefined : doc.walls?.[host.wall];
      if (!o || !d || !w) continue;
      // How far each face is from the opening's line, along the line's left normal, plus the lift.
      const line: P2[] = [o.start, o.end];
      const dx = o.end[0] - o.start[0];
      const dy = o.end[1] - o.start[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const at = (p: P2) => (p[0] - o.start[0]) * nx + (p[1] - o.start[1]) * ny;
      const toLeft = Math.max(at(d.startLeft), at(d.startRight));
      const toRight = Math.min(at(d.startLeft), at(d.startRight));
      strip(s, offsetLine(line, toLeft + OPENING_OUT), o.sillElevation, o.headElevation, band, x.element, w.level, false);
      strip(s, offsetLine(line, toRight - OPENING_OUT), o.sillElevation, o.headElevation, band, x.element, w.level, true);
    } else {
      const r = derived.roofs?.[x.element];
      const level = (doc.roofs as Record<string, { level: string }> | undefined)?.[x.element]?.level ?? '';
      if (!r?.surface) continue;
      for (const f of r.surface.faces) {
        const pts = f.polygon.map((p): P3 => [p[0], p[1], p[2] + ROOF_UP]);
        for (const [a, b, c] of earClip(pts.map((p): P2 => [p[0], p[1]]))) s.tri(pts[a]!, pts[b]!, pts[c]!, band, x.element, level);
      }
    }
  }
  const positions = new Float32Array(s.p.length);
  for (let i = 0; i < s.p.length; i++) positions[i] = (s.p[i]! - origin[i % 3]!) / UNITS_PER_METRE;
  return { positions, normals: Float32Array.from(s.n), bands: Uint8Array.from(s.b), elements: s.e, levels: s.l };
}
