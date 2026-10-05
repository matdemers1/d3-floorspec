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
 *   box equals it within Float32 rounding.
 */
import { expect } from 'vitest';
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { area2, clip, iarea2, Rat, rpoint, type IPoint, type RPoint } from '../src/exact.js';
import type { Kernel } from '../src/kernel.js';
import { UNITS_PER_METRE as BU, type Box3, type HouseMesh, type MeshPart, type PartMesh } from '../src/index.js';

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
  c0: bigint;
  c1: bigint;
  sill: number;
  head: number;
  poly: RPoint[];
}

function wallFacts(doc: FloorspecDocument, d: Derived, id: string): { ring: IPoint[]; base: number; top: number; cuts: WallCut[]; dir: IPoint } {
  const w = own(doc.walls, id);
  const dw = own(d.walls, id);
  const ring = dedupeRing([dw.startRight, dw.endRight, dw.endLeft, dw.startLeft].map(I));
  const S = I(own(doc.junctions, w.start).position);
  const E = I(own(doc.junctions, w.end).position);
  const dir: IPoint = [E[0] - S[0], E[1] - S[1]];
  const cuts: WallCut[] = [];
  for (const [oid, o] of Object.entries(doc.openings ?? {})) {
    if (o?.wall !== id) continue;
    const dop = own(d.openings, oid);
    const c0 = dir[0] * BigInt(dop.start[0]) + dir[1] * BigInt(dop.start[1]);
    const c1 = dir[0] * BigInt(dop.end[0]) + dir[1] * BigInt(dop.end[1]);
    if (c1 <= c0) continue;
    const poly = clip(clip(ring.map(rpoint), { a: dir, c: c0, s: 1 }), { a: dir, c: c1, s: -1 });
    cuts.push({ id: oid, c0, c1, sill: dop.sillElevation, head: dop.headElevation, poly });
  }
  return { ring, base: dw.baseElevation, top: dw.topElevation, cuts, dir };
}

/** A wall's genus where it is plain to see: every cut a tunnel or a notch from below, no two touching. Else undefined. */
function wallGenus(f: ReturnType<typeof wallFacts>): number | undefined {
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
      const ws = Object.entries(doc.walls ?? {}).filter(([, w]) => w?.start === p.id || w?.end === p.id).map(([wid]) => own(d.walls, wid));
      const base = Math.min(...ws.map((w) => w.baseElevation));
      const top = Math.max(...ws.map((w) => w.topElevation));
      const fill = own(d.junctionFills, p.id);
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
      const pieces = steps.map((st, k) => ({ ...st, lo: k >= 2 ? steps[k - 2]!.top : s.bottom }));
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
      const n = [-Number(f.dir[1]), Number(f.dir[0])];
      const len = Math.hypot(n[0]!, n[1]!);
      const c = [(dop.start[0] + dop.end[0]) / 2, (dop.start[1] + dop.end[1]) / 2, (dop.sillElevation + dop.headElevation) / 2];
      const m = (s: number): number[] => [0, 1, 2].map((k) => (c[k]! + (k < 2 ? (s * n[k]!) / len : 0) - mesh.origin[k]!) / BU);
      const [a, b] = [m(-100 * BU), m(100 * BU)];
      expect(hits(wall!.mesh, a, b), `${label}: the ray through the opening meets its wall`).toBe(0);
      expect(hits(p.mesh, a, b), `${label}: the ray meets the opening's own void`).toBeGreaterThanOrEqual(2);
    }
  }
  return sum;
}
