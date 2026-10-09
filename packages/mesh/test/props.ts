/**
 * The properties every meshed house must have (FLR-REQ-112), checked against values computed here
 * from the document and the engine's derived values — never from the mesher's own intermediate
 * geometry:
 *
 * - every solid is watertight: each directed edge has exactly one twin, the Float32 output imports
 *   into manifold-3d with status NoError, and its Euler-characteristic genus equals manifold-3d's;
 * - every solid's volume equals the exact analytic volume — exactly, for parts built from exact
 *   points; within 1e-9 relative for parts manifold-3d built in double precision; and the Float32
 *   output's volume within 1e-4;
 * - every opening is cut: a ray through its centre, square to its wall, meets none of the wall's
 *   triangles (and does meet its own void, the control);
 * - every bounding box is exact: equal to the engine's derived box where the engine derives one, and
 *   to manifold-3d's double-precision box within 1e-9 m where it does not; the Float32 positions'
 *   box equals it within Float32 rounding;
 * - every doorway is floored (FLR-T-12.20): under a door or an empty opening whose sill is its wall's
 *   base, a vertical ray each side of the location line meets the opening's threshold, whose volume
 *   is its half of the cut's plan between its room's floor's bottom and top;
 * - no corner is left open (FLR-T-12.20): where a separator sits between two walls whose faces are not
 *   parallel there, a point inside the corner those faces would have made is inside the junction's
 *   closure.
 */
import { expect } from 'vitest';
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { area2, clip, iarea2, Rat, rpoint, type IPoint, type RPoint } from '../src/exact.js';
import type { Kernel } from '../src/kernel.js';
import { UNITS_PER_METRE as BU, type Box3, type HouseMesh, type MeshPart, type PartMesh } from '../src/index.js';
import { treadOutlines } from '../src/stairs.js';

const own = <T>(c: Record<string, T | undefined> | undefined, id: string): T => {
  if (!c || !Object.hasOwn(c, id)) throw new Error(`no ${id}`);
  return c[id]!;
};
const I = (p: readonly [number, number]): IPoint => [BigInt(p[0]), BigInt(p[1])];

function dedupeRing(ring: readonly IPoint[]): IPoint[] {
  const out: IPoint[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

// ── topology ────────────────────────────────────────────────────────────────────

export interface Topology {
  vertices: number;
  edges: number;
  faces: number;
  components: number;
  /** The Euler characteristic V − E + F. */
  chi: number;
  /** The sum of its components' genera: C − χ / 2. */
  genus: number;
}

/** Check a mesh's indices and, for a solid, that every directed edge has exactly one twin; its Euler genus. */
export function topology(mesh: PartMesh, closed: boolean, label: string): Topology {
  const nv = mesh.positions.length / 3;
  const ix = mesh.indices;
  expect(ix.length % 3, label).toBe(0);
  for (const v of mesh.positions) expect(Number.isFinite(v), label).toBe(true);
  const directed = new Map<number, number>();
  const parent = Array.from({ length: nv }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const used = new Set<number>();
  for (let t = 0; t < ix.length; t += 3) {
    const tri = [ix[t]!, ix[t + 1]!, ix[t + 2]!];
    for (const i of tri) {
      expect(i < nv, label).toBe(true);
      used.add(i);
    }
    expect(new Set(tri).size, `${label}: a triangle repeats a vertex`).toBe(3);
    for (let k = 0; k < 3; k++) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      directed.set(a * nv + b, (directed.get(a * nv + b) ?? 0) + 1);
      parent[find(a)] = find(b);
    }
  }
  if (closed) {
    for (const [key, count] of directed) {
      const a = Math.floor(key / nv);
      const b = key % nv;
      expect(count, `${label}: edge ${a}→${b} is used ${count} times`).toBe(1);
      expect(directed.get(b * nv + a), `${label}: edge ${a}→${b} has no twin`).toBe(1);
    }
  }
  const roots = new Set([...used].map(find));
  const edges = closed ? directed.size / 2 : new Set([...directed.keys()].map((k) => Math.min(k, (k % nv) * nv + Math.floor(k / nv)))).size;
  const chi = used.size - edges + ix.length / 3;
  return { vertices: used.size, edges, faces: ix.length / 3, components: roots.size, chi, genus: roots.size - chi / 2 };
}

/** The Float32 output as manifold-3d reads it: its status, genus and volume (m³). */
export function imported(kernel: Kernel, mesh: PartMesh): { status: string; genus: number; volume: number } {
  const m = new kernel.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  const man = new kernel.Manifold(m);
  try {
    return { status: man.status(), genus: man.genus(), volume: man.volume() };
  } finally {
    man.delete();
  }
}

// ── rays ────────────────────────────────────────────────────────────────────────

/** How many triangles the segment p → q meets, edges and vertices included (Möller–Trumbore). */
export function hits(mesh: PartMesh, p: readonly number[], q: readonly number[]): number {
  const P = mesh.positions;
  const d = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
  let n = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!].map((i) => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!]) as [number[], number[], number[]];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const h = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(det) < 1e-18) continue;
    const s = [p[0]! - a[0]!, p[1]! - a[1]!, p[2]! - a[2]!];
    const u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / det;
    const qv = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const v = (d[0]! * qv[0]! + d[1]! * qv[1]! + d[2]! * qv[2]!) / det;
    const w = (e2[0]! * qv[0]! + e2[1]! * qv[1]! + e2[2]! * qv[2]!) / det;
    const eps = 1e-9;
    if (u >= -eps && v >= -eps && u + v <= 1 + eps && w >= -eps && w <= 1 + eps) n++;
  }
  return n;
}

// ── boxes ───────────────────────────────────────────────────────────────────────

/** The box of a mesh's positions, in metres. */
function positionsBox(mesh: PartMesh): Box3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const i of mesh.indices)
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[3 * i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  return { min, max };
}

/** One metre's billionth, in base units: the double-precision tolerance. */
const NANOMETRE = BU / 1e9;

function expectBoxNear(actual: Box3, expected: Box3, tol: number, label: string): void {
  for (const c of ['min', 'max'] as const)
    for (let k = 0; k < 3; k++) expect(Math.abs(actual[c][k]! - expected[c][k]!), `${label}: ${c}[${k}] ${actual[c][k]} vs ${expected[c][k]}`).toBeLessThanOrEqual(tol);
}

const box3 = (b: { min: readonly number[]; max: readonly number[] }): Box3 => ({ min: [b.min[0]!, b.min[1]!, b.min[2]!], max: [b.max[0]!, b.max[1]!, b.max[2]!] });

function planBox(points: readonly (readonly [number, number])[], z0: number, z1: number): Box3 {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys), z0], max: [Math.max(...xs), Math.max(...ys), z1] };
}


// ── thresholds and closures (FLR-T-12.20) ───────────────────────────────────────

const inPoly = (ring: readonly (readonly [number, number])[], x: number, y: number): boolean => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** A threshold-bearing opening: a door's or an empty opening's on a straight wall, its sill at the wall's base. */
interface Doorway {
  id: string;
  wall: string;
  /** The room on each side: its face's (18.6), or the one a millimetre past the face at the opening's middle. */
  rooms: { left?: string; right?: string };
  /** Each side's half of the cut's plan, rounded once, and a point well inside it. */
  halves: { left?: { ring: IPoint[]; probe: [number, number] }; right?: { ring: IPoint[]; probe: [number, number] } };
}

function doorways(doc: FloorspecDocument, d: Derived): Doorway[] {
  const out: Doorway[] = [];
  for (const [oid, o] of Object.entries(doc.openings ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (o === undefined) continue;
    const w = own(doc.walls, o.wall);
    const dw = own(d.walls, o.wall);
    const dop = own(d.openings, oid);
    const t = o.fill === undefined ? undefined : doc.types?.[o.fill];
    if (t?.kind === 'windowType' || dw.polyline !== undefined || w.arc?.sagitta || dop.sillElevation !== dw.baseElevation) continue;
    const f = wallFacts(doc, d, o.wall);
    const cut = f.cuts.find((c) => c.id === oid);
    if (!cut) continue;
    const S = own(doc.junctions, w.start).position;
    const E = own(doc.junctions, w.end).position;
    const len = Math.hypot(E[0] - S[0], E[1] - S[1]);
    const n = [-(E[1] - S[1]) / len, (E[0] - S[0]) / len] as const;
    const nI: IPoint = [BigInt(S[1] - E[1]), BigInt(E[0] - S[0])];
    const ns = nI[0] * BigInt(S[0]) + nI[1] * BigInt(S[1]);
    const mid = [(dop.start[0] + dop.end[0]) / 2, (dop.start[1] + dop.end[1]) / 2] as const;
    const way: Doorway = { id: oid, wall: o.wall, rooms: {}, halves: {} };
    for (const side of ['left', 'right'] as const) {
      const at = side === 'left' ? dw.startLeft : dw.startRight;
      const face = (at[0] - S[0]) * n[0] + (at[1] - S[1]) * n[1];
      const k = face + (side === 'left' ? 1280 : -1280);
      const room =
        d.finishes?.walls[o.wall]?.[side]?.room ??
        Object.keys(d.rooms)
          .sort()
          .find((r) => own(doc.rooms, r).level === w.level && inPoly(d.rooms[r]!.outer, mid[0] + k * n[0], mid[1] + k * n[1]) && !d.rooms[r]!.holes.some((h) => inPoly(h, mid[0] + k * n[0], mid[1] + k * n[1])));
      if (room !== undefined) way.rooms[side] = room;
      const half = clip(cut.poly, { a: nI, c: ns, s: side === 'left' ? 1 : -1 });
      const ring = dedupeRing(half.map((q): IPoint => [q[0].round(), q[1].round()]));
      if (ring.length < 3 || iarea2(ring) <= 0n || Math.abs(face) < 4) continue;
      way.halves[side] = { ring, probe: [mid[0] + (face / 2) * n[0], mid[1] + (face / 2) * n[1]] };
    }
    out.push(way);
  }
  return out;
}

/** A corner a separator leaves open between two walls, found here from the derived face ends and the walls' directions. */
interface OpenCorner {
  junction: string;
  /** The wall before the separators (counter-clockwise) and the one after. */
  walls: [string, string];
  /** The first's outgoing-left face end, the second's outgoing-right one, and where those faces' lines meet, rounded once. */
  L: IPoint;
  R: IPoint;
  X: IPoint;
  /** The closure: from R back along the fill's boundary to L, then X; counter-clockwise. */
  ring: IPoint[];
}

function openCorners(doc: FloorspecDocument, d: Derived): OpenCorner[] {
  const out: OpenCorner[] = [];
  for (const [jid, j] of Object.entries(doc.junctions ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (j === undefined || j.join?.kind === 'butt') continue;
    const P = j.position;
    const ends: { wall?: string; ang: number; d: IPoint; L?: IPoint; R?: IPoint }[] = [];
    let arc = false;
    for (const [, s] of Object.entries(doc.separators ?? {})) {
      if (s === undefined || (s.start !== jid && s.end !== jid)) continue;
      if (s.arc?.sagitta) arc = true;
      const o = own(doc.junctions, s.start === jid ? s.end : s.start).position;
      ends.push({ ang: Math.atan2(o[1] - P[1], o[0] - P[0]), d: [BigInt(o[0] - P[0]), BigInt(o[1] - P[1])] });
    }
    if (!ends.length) continue;
    for (const [wid, w] of Object.entries(doc.walls ?? {})) {
      if (w === undefined || (w.start !== jid && w.end !== jid)) continue;
      if (w.arc?.sagitta) arc = true;
      const dw = own(d.walls, wid);
      const atStart = w.start === jid;
      const o = own(doc.junctions, atStart ? w.end : w.start).position;
      ends.push({ wall: wid, ang: Math.atan2(o[1] - P[1], o[0] - P[0]), d: [BigInt(o[0] - P[0]), BigInt(o[1] - P[1])], L: I(atStart ? dw.startLeft : dw.endRight), R: I(atStart ? dw.startRight : dw.endLeft) });
    }
    if (arc || ends.filter((e) => e.wall).length < 2) continue;
    ends.sort((a, b) => ((a.ang + 2 * Math.PI) % (2 * Math.PI)) - ((b.ang + 2 * Math.PI) % (2 * Math.PI)));
    const fill = d.junctionFills[jid]?.map(I);
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i]!;
      const b = ends[(i + 1) % ends.length]!;
      if (!a.wall || b.wall) continue;
      let m = (i + 1) % ends.length;
      while (!ends[m]!.wall) m = (m + 1) % ends.length;
      const c = ends[m]!;
      if (c.wall === a.wall) continue;
      const den = a.d[0] * c.d[1] - a.d[1] * c.d[0];
      if (den === 0n) continue;
      const L = a.L!;
      const R = c.R!;
      // L + t·a.d on c's right face line: t = ((R − L) × c.d) / (a.d × c.d).
      const t = new Rat((R[0] - L[0]) * c.d[1] - (R[1] - L[1]) * c.d[0], den);
      const X: IPoint = [new Rat(L[0]).add(t.mul(new Rat(a.d[0]))).round(), new Rat(L[1]).add(t.mul(new Rat(a.d[1]))).round()];
      const eq = (p: IPoint, q: IPoint): boolean => p[0] === q[0] && p[1] === q[1];
      let path: IPoint[] = [L, R];
      const k = fill ? fill.findIndex((p) => eq(p, L)) : -1;
      if (fill && k >= 0) {
        const walk: IPoint[] = [];
        for (let s = 0; s < fill.length; s++) {
          walk.push(fill[(k + s) % fill.length]!);
          if (eq(walk[walk.length - 1]!, R)) {
            path = walk;
            break;
          }
        }
      }
      const ring = dedupeRing([...path, X]);
      if (ring.length < 3 || iarea2(ring) >= 0n) continue;
      out.push({ junction: jid, walls: [a.wall, c.wall!], L, R, X, ring: ring.reverse() });
    }
  }
  return out;
}

/** Is a point inside a closed mesh? The parity of a ray's crossings, the ray skewed off every axis. */
function contains(mesh: PartMesh, p: readonly number[]): boolean {
  return hits(mesh, p, [p[0]! + 0.000137, p[1]! + 0.000071, p[2]! + 1000]) % 2 === 1;
}

// ── analytic values ─────────────────────────────────────────────────────────────

/** Six times a prism's volume: 3 · (twice the plan area) · height. */
const prism6 = (twiceArea: bigint, height: number): bigint => 3n * twiceArea * BigInt(height);

interface Expected {
  /** Six times the exact volume, when the part is built from exact points. */
  volume6?: bigint;
  /** The exact volume as a rational, for a part manifold-3d builds in double precision. */
  volume?: Rat;
  /** A relative tolerance on `volume6` where rounding makes the faces only nearly planar. */
  rel?: number;
  /** The exact box the engine derives. */
  box?: Box3;
  /** Only the plan extent and the bottom of `box` (a stair's pieces stop a riser below its top). */
  planBoxAndBottom?: Box3;
  genus?: number;
}

interface WallCut {
  id: string;
  /** The direction the cut is square to: the wall's, or on an arc wall the opening's chord (Core 21.6). */
  dir: IPoint;
  c0: bigint;
  c1: bigint;
  sill: number;
  head: number;
  poly: RPoint[];
}

function wallFacts(doc: FloorspecDocument, d: Derived, id: string): { ring: IPoint[]; base: number; top: number; cuts: WallCut[]; dir: IPoint; arc: boolean } {
  const w = own(doc.walls, id);
  const dw = own(d.walls, id);
  // Core 0.4, 21.4: an arc wall's outline runs through its face vertices.
  const ring = dedupeRing([dw.startRight, ...(dw.right ?? []), dw.endRight, dw.endLeft, ...[...(dw.left ?? [])].reverse(), dw.startLeft].map(I));
  const S = I(own(doc.junctions, w.start).position);
  const E = I(own(doc.junctions, w.end).position);
  const wallDir: IPoint = [E[0] - S[0], E[1] - S[1]];
  const arc = dw.polyline !== undefined && w.arc !== undefined;
  const cuts: WallCut[] = [];
  for (const [oid, o] of Object.entries(doc.openings ?? {})) {
    if (o?.wall !== id) continue;
    const dop = own(d.openings, oid);
    const s = I(dop.start);
    const e = I(dop.end);
    // 21.6: on an arc wall an opening stands on its chord, and its cut is square to the chord, across the
    // wall's thickness and the bow of the wall past the chord (the arc's sagitta for the chord's length).
    const dir: IPoint = arc ? [e[0] - s[0], e[1] - s[1]] : wallDir;
    const c0 = dir[0] * s[0] + dir[1] * s[1];
    const c1 = dir[0] * e[0] + dir[1] * e[1];
    if (c1 <= c0) continue;
    let poly = clip(clip(ring.map(rpoint), { a: dir, c: c0, s: 1 }), { a: dir, c: c1, s: -1 });
    if (arc) {
      const g = (x: bigint, y: bigint): bigint => (y === 0n ? (x < 0n ? -x : x) : g(y, x % y));
      const k0 = g(dir[0], dir[1]);
      const n: IPoint = [-dir[1] / k0, dir[0] / k0];
      const nLen = Math.hypot(Number(n[0]), Number(n[1]));
      const c = Math.hypot(Number(wallDir[0]), Number(wallDir[1]));
      const h = Math.abs(w.arc!.sagitta);
      const R = (c * c + 4 * h * h) / (8 * h);
      const l = Math.hypot(Number(dir[0]), Number(dir[1]));
      const bow = R - Math.sqrt(Math.max(R * R - (l * l) / 4, 0));
      const t = own(doc.types, w.type!);
      const T = (w.layers ?? (t.kind === 'wallType' ? t.layers : [])).reduce((x, y) => x + y.thickness, 0);
      const k = BigInt(Math.ceil((T + bow + 2) / nLen));
      const ns = n[0] * s[0] + n[1] * s[1];
      const nn = n[0] * n[0] + n[1] * n[1];
      poly = clip(clip(poly, { a: n, c: ns - k * nn, s: 1 }), { a: n, c: ns + k * nn, s: -1 });
    }
    cuts.push({ id: oid, dir, c0, c1, sill: dop.sillElevation, head: dop.headElevation, poly });
  }
  return { ring, base: dw.baseElevation, top: underRoof(doc, d, w.level, [dw.startRight, ...(dw.right ?? []), dw.endRight, dw.endLeft, ...[...(dw.left ?? [])].reverse(), dw.startLeft], dw.baseElevation, dw.topElevation), cuts, dir: wallDir, arc };
}

/**
 * The height a wall's or junction fill's solid rises to (FLR-T-12.12): the underside of a flat roof
 * with a thickness, on its level, whose slab holds its top — when its whole plan is inside or on the
 * roof's eave outline — else its own top.
 */
function underRoof(doc: FloorspecDocument, d: Derived, level: string, plan: readonly (readonly [number, number])[], base: number, top: number): number {
  const on = (poly: readonly (readonly [number, number])[], x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j]!;
      const [bx, by] = poly[i]!;
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      const len = Math.hypot(bx - ax, by - ay);
      const dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay);
      if (len > 0 && Math.abs(cross) / len <= 1 && dot >= -len && dot <= len * len + len) return true;
      if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
    }
    return inside;
  };
  for (const [id, r] of Object.entries(d.roofs ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const roof = own(doc.roofs, id);
    const t = roof.thickness ?? 0;
    if (roof.level !== level || r.kind !== 'flat' || !r.surface || t <= 0) continue;
    const under = r.eave - t;
    if (top > under && top <= r.eave && under > base && plan.every(([x, y]) => on(r.outline, x, y))) return under;
  }
  return top;
}

/** A wall's genus where it is plain to see: every cut a tunnel or a notch from below, no two touching. Else undefined. */
function wallGenus(f: ReturnType<typeof wallFacts>): number | undefined {
  if (f.arc) return undefined; // cuts square to different chords: not plain to see
  let g = 0;
  for (const c of f.cuts) {
    const along = f.ring.map((V) => f.dir[0] * V[0] + f.dir[1] * V[1]);
    if (along.some((t) => t >= c.c0 && t <= c.c1) || c.head >= f.top) return undefined;
    if (c.sill > f.base) g++;
  }
  for (const a of f.cuts) for (const b of f.cuts) if (a !== b && (a.c0 > b.c0 ? a.c0 : b.c0) <= (a.c1 < b.c1 ? a.c1 : b.c1) && Math.max(a.sill, b.sill) <= Math.min(a.head, b.head)) return undefined;
  return g;
}

/** Six times the volume under a roof's faces down to its eave, by fans over the derived face polygons; and whether every face is planar. */
function shellVolume6(faces: readonly { polygon: [number, number, number][] }[], eave: number): { v6: bigint; planar: boolean } {
  let v6 = 0n;
  let planar = true;
  for (const f of faces) {
    const p = f.polygon.map((q) => q.map(BigInt) as [bigint, bigint, bigint]);
    for (let i = 1; i + 1 < p.length; i++) {
      const [a, b, c] = [p[0]!, p[i]!, p[i + 1]!];
      const twice = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      v6 += twice * (a[2] + b[2] + c[2] - 3n * BigInt(eave));
    }
    // Planar: every point on the plane of the first three that are not collinear.
    let n: [bigint, bigint, bigint] | undefined;
    for (let i = 1; i + 1 < p.length && !n; i++) {
      const u = [p[i]![0] - p[0]![0], p[i]![1] - p[0]![1], p[i]![2] - p[0]![2]];
      const v = [p[i + 1]![0] - p[0]![0], p[i + 1]![1] - p[0]![1], p[i + 1]![2] - p[0]![2]];
      const c: [bigint, bigint, bigint] = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      if (c[0] !== 0n || c[1] !== 0n || c[2] !== 0n) n = c;
    }
    if (n && p.some((q) => n[0] * (q[0] - p[0]![0]) + n[1] * (q[1] - p[0]![1]) + n[2] * (q[2] - p[0]![2]) !== 0n)) planar = false;
  }
  return { v6, planar };
}

/** What each part should be, computed from the document and the engine's derived values. */
function expected(doc: FloorspecDocument, d: Derived, p: MeshPart): Expected {
  const ring2 = (r: readonly (readonly [number, number])[]): bigint => iarea2(r.map(I));
  switch (p.kind) {
    case 'wall': {
      const f = wallFacts(doc, d, p.id);
      let v = new Rat(iarea2(f.ring) * BigInt(f.top - f.base), 2n);
      for (const c of f.cuts) v = v.sub(area2(c.poly).mul(new Rat(BigInt(c.head - c.sill), 2n)));
      const g = wallGenus(f);
      return { volume: v, ...(g !== undefined && { genus: g }) };
    }
    case 'opening': {
      const o = own(doc.openings, p.id);
      const c = wallFacts(doc, d, o.wall).cuts.find((x) => x.id === p.id)!;
      return { volume: area2(c.poly).mul(new Rat(BigInt(c.head - c.sill), 2n)), genus: 0 };
    }
    case 'junctionFill': {
      if (p.key.includes(':closure:')) {
        const c = openCorners(doc, d).find((x) => `junctionFill:${x.junction}:closure:${x.walls[0]}` === p.key);
        expect(c, `${p.key}: a corner a separator leaves open`).toBeDefined();
        const ws = c!.walls.map((w) => own(d.walls, w));
        const base = Math.min(...ws.map((w) => w.baseElevation));
        const ring = c!.ring.map((q): [number, number] => [Number(q[0]), Number(q[1])]);
        const top = underRoof(doc, d, own(doc.junctions, p.id).level, ring, base, Math.max(...ws.map((w) => w.topElevation)));
        return { volume6: prism6(iarea2(c!.ring), top - base), box: planBox(ring, base, top), genus: 0 };
      }
      const ws = Object.entries(doc.walls ?? {}).filter(([, w]) => w?.start === p.id || w?.end === p.id).map(([wid]) => own(d.walls, wid));
      const base = Math.min(...ws.map((w) => w.baseElevation));
      const fill = own(d.junctionFills, p.id);
      const top = underRoof(doc, d, own(doc.junctions, p.id).level, fill, base, Math.max(...ws.map((w) => w.topElevation)));
      return { volume6: prism6(ring2(fill), top - base), box: planBox(fill, base, top), genus: 0 };
    }
    case 'floor': {
      const fl = own(d.floors, p.id);
      const room = own(d.rooms, p.id);
      const twice = BigInt(room.area.replace('.5', '')) * 2n + (room.area.endsWith('.5') ? (room.area.startsWith('-') ? -1n : 1n) : 0n);
      return p.closed ? { volume6: prism6(twice, fl.top - fl.bottom), box: box3(fl.box), genus: room.holes.length } : { box: box3(fl.box) };
    }
    case 'ceiling':
      return { box: box3(own(d.ceilings, p.id).box) };
    case 'slab': {
      const s = own(d.slabs, p.id);
      return { volume6: prism6(ring2(s.outline), s.top - s.bottom), box: box3(s.box), genus: 0 };
    }
    case 'roof': {
      const r = own(d.roofs, p.id);
      const t = own(doc.roofs, p.id).thickness ?? 0;
      if (!r.surface) return { box: planBox(r.outline, r.eave, r.eave) };
      const box = box3(r.surface.box);
      if (!p.closed) return { box };
      if (t > 0) return { volume6: prism6(ring2(r.outline), t), box, genus: 0 };
      const { v6, planar } = shellVolume6(r.surface.faces, r.eave);
      return { volume6: v6, ...(planar ? {} : { rel: 1e-6 }), box, genus: 0 };
    }
    case 'roofGable':
      return {};
    case 'stairFlight':
    case 'stairLanding': {
      const s = own(d.stairs, p.id);
      const steps = s.steps!;
      // Tapered treads stop short of the point they meet at, and share their faces exactly (treadOutlines).
      const outlines = treadOutlines(own(doc.stairs, p.id), s);
      const pieces = steps.map((st, k) => ({ ...st, outline: outlines[k]!, lo: k >= 2 ? steps[k - 2]!.top : s.bottom }));
      // The pieces of this part: flights are the runs between landings, numbered from 1.
      const groups: { kind: 'stairFlight' | 'stairLanding'; n: number; pieces: typeof pieces }[] = [];
      let flights = 0;
      let landings = 0;
      for (const pc of pieces) {
        if (pc.landing) groups.push({ kind: 'stairLanding', n: ++landings, pieces: [pc] });
        else if (groups.length && groups[groups.length - 1]!.kind === 'stairFlight') groups[groups.length - 1]!.pieces.push(pc);
        else groups.push({ kind: 'stairFlight', n: ++flights, pieces: [pc] });
      }
      const g = groups.find((x) => `${x.kind}:${p.id}:${x.kind === 'stairFlight' ? 'flight' : 'landing'}${x.n}` === p.key)!;
      expect(g, `${p.key}: no such piece`).toBeDefined();
      const v6 = g.pieces.reduce((a, pc) => a + prism6(ring2(pc.outline), pc.top - pc.lo), 0n);
      const all = pieces.flatMap((pc) => pc.outline);
      const xy = planBox(all, s.bottom, s.top);
      const mine = planBox(
        g.pieces.flatMap((pc) => pc.outline),
        Math.min(...g.pieces.map((pc) => pc.lo)),
        Math.max(...g.pieces.map((pc) => pc.top)),
      );
      for (let k = 0; k < 2; k++) {
        expect(mine.min[k]).toBeGreaterThanOrEqual(xy.min[k]!);
        expect(mine.max[k]).toBeLessThanOrEqual(xy.max[k]!);
      }
      // A spiral's box is its circle's (Core 17.4), which its treads' corners reach only where a nosing line points along an axis.
      if (own(doc.stairs, p.id).form?.kind !== 'spiral') {
        expect(s.box.min.slice(0, 2), `${p.key}: the steps' corners are the stair's box`).toEqual(xy.min.slice(0, 2));
        expect(s.box.max.slice(0, 2), `${p.key}: the steps' corners are the stair's box`).toEqual(xy.max.slice(0, 2));
      } else {
        for (let k = 0; k < 2; k++) {
          expect(xy.min[k]).toBeGreaterThanOrEqual(s.box.min[k]!);
          expect(xy.max[k]).toBeLessThanOrEqual(s.box.max[k]!);
        }
      }
      return p.kind === 'stairFlight' ? { volume: new Rat(v6, 6n), box: mine, genus: 0 } : { volume6: v6, box: mine, genus: 0 };
    }
    case 'stairColumn': {
      // A 32-sided prism of the spiral's column radius about its centre (a mesh is not normative), as tall as the stair.
      const s = own(d.stairs, p.id);
      const st = own(doc.stairs, p.id);
      const f = st.form as { diameter: number };
      const r = f.diameter / 2 - st.width > 0 ? f.diameter / 2 - st.width : 32_512;
      const [cx, cy] = s.centre!;
      const ring = Array.from({ length: 32 }, (_, i): [number, number] => [Math.round(cx + r * Math.cos((2 * Math.PI * i) / 32)), Math.round(cy + r * Math.sin((2 * Math.PI * i) / 32))]);
      return { volume6: prism6(ring2(ring), s.top - s.bottom), box: planBox(ring, s.bottom, s.top), genus: 0 };
    }
    case 'stairBlock': {
      const b = own(d.stairs, p.id).box;
      return { volume6: 6n * BigInt(b.max[0] - b.min[0]) * BigInt(b.max[1] - b.min[1]) * BigInt(b.max[2] - b.min[2]), box: box3(b), genus: 0 };
    }
    case 'threshold': {
      const way = doorways(doc, d).find((x) => x.id === p.id);
      const side = p.threshold!.side;
      const half = way?.halves[side];
      expect(half, `${p.key}: a doorway's half`).toBeDefined();
      // The room on its side, or — outside the house — the other side's.
      expect(p.threshold!.room).toBe(way!.rooms[side] ?? way!.rooms[side === 'left' ? 'right' : 'left']);
      const fl = own(d.floors, p.threshold!.room);
      const ring = half!.ring.map((q): [number, number] => [Number(q[0]), Number(q[1])]);
      return p.closed ? { volume6: prism6(iarea2(half!.ring), fl.top - fl.bottom), box: planBox(ring, fl.bottom, fl.top), genus: 0 } : { box: planBox(ring, fl.top, fl.top) };
    }
    case 'extension': {
      const f = own(d.fallbacks, p.id);
      return { volume6: prism6(ring2(f.footprint), f.top - f.bottom), box: planBox(f.footprint, f.bottom, f.top), genus: 0 };
    }
  }
}

export interface Summary {
  solids: number;
  surfaces: number;
  openings: number;
  parts: number;
}

/** Check every property of every part of a meshed house. */
export function checkHouse(kernel: Kernel, doc: FloorspecDocument, d: Derived, mesh: HouseMesh, name: string): Summary {
  const sum: Summary = { solids: 0, surfaces: 0, openings: 0, parts: mesh.parts.length };
  const keys = new Set<string>();
  for (const p of mesh.parts) {
    const label = `${name} ${p.key}`;
    expect(keys.has(p.key), `${label}: duplicate key`).toBe(false);
    keys.add(p.key);
    expect(p.mesh.indices.length, `${label}: empty`).toBeGreaterThan(0);
    const topo = topology(p.mesh, p.closed, label);
    const exp = expected(doc, d, p);
    const stats = p.stats!;

    // The Float32 output's box is the exact box after the one conversion, within Float32 rounding.
    const pb = positionsBox(p.mesh);
    for (const c of ['min', 'max'] as const)
      for (let k = 0; k < 3; k++) {
        const want = (p.bbox[c][k]! - mesh.origin[k]!) / BU;
        expect(Math.abs(pb[c][k]! - want), `${label}: Float32 ${c}[${k}]`).toBeLessThanOrEqual(1.2e-7 * Math.max(Math.abs(want), 1e-3));
      }
    // The exact box is the engine's, where it derives one; and the source geometry's, within a nanometre.
    if (exp.box) expect(p.bbox, `${label}: box`).toEqual(exp.box);
    expectBoxNear(stats.box, p.bbox, NANOMETRE, `${label}: source box`);

    if (!p.closed) {
      sum.surfaces++;
      continue;
    }
    sum.solids++;
    const im = imported(kernel, p.mesh);
    expect(im.status, `${label}: manifold-3d reads the output`).toBe('NoError');
    // manifold-3d's genus is 1 − χ / 2 over the whole mesh, whatever its number of pieces.
    expect(1 - topo.chi / 2, `${label}: Euler genus vs manifold-3d`).toBe(im.genus);
    if (stats.genus !== undefined) expect(stats.genus, `${label}: source genus`).toBe(im.genus);
    if (exp.genus !== undefined) expect(im.genus, `${label}: genus`).toBe(exp.genus);
    if (exp.genus !== undefined) expect(topo.components, `${label}: one piece`).toBe(1);

    let analytic: number;
    if (exp.volume6 !== undefined) {
      expect(stats.exactVolume, `${label}: an exact part's volume is exact`).toBe(true);
      const got = BigInt(stats.volume6!);
      if (exp.rel === undefined) expect(got, `${label}: exact volume`).toBe(exp.volume6);
      else expect(Math.abs(Number(got - exp.volume6)) / Math.abs(Number(exp.volume6)), `${label}: volume`).toBeLessThanOrEqual(exp.rel);
      analytic = Number(exp.volume6) / 6;
    } else {
      analytic = exp.volume!.toNumber();
      expect(Math.abs(stats.volume - analytic) / analytic, `${label}: volume ${stats.volume} vs ${analytic}`).toBeLessThanOrEqual(1e-9);
    }
    expect(analytic, `${label}: positive volume`).toBeGreaterThan(0);
    expect(Math.abs(im.volume - analytic / BU ** 3) / (analytic / BU ** 3), `${label}: Float32 volume`).toBeLessThanOrEqual(1e-4);

    if (p.kind === 'opening') {
      sum.openings++;
      const o = own(doc.openings, p.id);
      const wall = mesh.parts.find((q) => q.kind === 'wall' && q.id === o.wall);
      expect(wall, `${label}: its wall`).toBeDefined();
      const dop = own(d.openings, p.id);
      const f = wallFacts(doc, d, o.wall);
      const dir = f.cuts.find((x) => x.id === p.id)?.dir ?? f.dir;
      const n = [-Number(dir[1]), Number(dir[0])];
      const len = Math.hypot(n[0]!, n[1]!);
      const c = [(dop.start[0] + dop.end[0]) / 2, (dop.start[1] + dop.end[1]) / 2, (dop.sillElevation + dop.headElevation) / 2];
      const m = (s: number): number[] => [0, 1, 2].map((k) => (c[k]! + (k < 2 ? (s * n[k]!) / len : 0) - mesh.origin[k]!) / BU);
      const [a, b] = [m(-100 * BU), m(100 * BU)];
      expect(hits(wall!.mesh, a, b), `${label}: the ray through the opening meets its wall`).toBe(0);
      expect(hits(p.mesh, a, b), `${label}: the ray meets the opening's own void`).toBeGreaterThanOrEqual(2);
    }
  }

  // Every doorway is floored: a ray down through each half of its cut meets its threshold.
  if (d.floors !== undefined)
    for (const way of doorways(doc, d)) {
      if (way.rooms.left === undefined && way.rooms.right === undefined) continue;
      const level = own(doc.walls, way.wall).level;
      if (!mesh.parts.some((q) => q.level === level)) continue;
      for (const side of ['left', 'right'] as const) {
        const half = way.halves[side];
        if (!half) continue;
        const t = mesh.parts.find((q) => q.key === `threshold:${way.id}:${side}`);
        expect(t, `${name} ${way.id}: the ${side} half of its doorway has a threshold`).toBeDefined();
        const at = (z: number): number[] => [(half.probe[0] - mesh.origin[0]) / BU, (half.probe[1] - mesh.origin[1]) / BU, (z - mesh.origin[2]) / BU];
        const fl = own(d.floors, t!.threshold!.room);
        expect(hits(t!.mesh, at(fl.top + BU), at(fl.bottom - BU)), `${name} ${way.id}: a ray down the ${side} half of the doorway meets its threshold`).toBeGreaterThanOrEqual(1);
      }
    }

  // No corner is left open: a point inside each corner a separator leaves is inside the junction's closure.
  for (const c of openCorners(doc, d)) {
    const level = own(doc.junctions, c.junction).level;
    if (!mesh.parts.some((q) => q.level === level && q.kind === 'wall')) continue;
    const part = mesh.parts.find((q) => q.key === `junctionFill:${c.junction}:closure:${c.walls[0]}`);
    expect(part, `${name} ${c.junction}: the corner between ${c.walls.join(' and ')} is closed`).toBeDefined();
    const ws = c.walls.map((w) => own(d.walls, w));
    const z = (Math.max(...ws.map((w) => w.baseElevation)) + Math.min(...ws.map((w) => w.topElevation))) / 2;
    const q = [0, 1].map((k) => Number(c.X[k]!) + (Number(c.L[k]!) - Number(c.X[k]!)) / 4 + (Number(c.R[k]!) - Number(c.X[k]!)) / 4);
    expect(contains(part!.mesh, [(q[0]! - mesh.origin[0]) / BU, (q[1]! - mesh.origin[1]) / BU, (z - mesh.origin[2]) / BU]), `${name} ${c.junction}: inside the corner is closed`).toBe(true);
  }
  return sum;
}
