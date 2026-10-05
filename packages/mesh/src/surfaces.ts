/**
 * Texture space on a meshed part (Core 0.3, 18.3; FLR-T-8.2): a part's triangles grouped by the
 * finished surface they lie on — a wall's left or right face, a region of a face, a room's floor or
 * its ceiling — each group with the material that finishes it (18.6) and every vertex's **surface
 * coordinates** `(s, t)` in base units, so a renderer or an exporter lays a texture's tiles at their
 * real-world size and in the place 18.3 defines.
 *
 * | Surface | s | t |
 * |---|---|---|
 * | right face of W | (P − S) · e | z − b |
 * | left face of W | (S − P) · e | z − b |
 * | region of a right face | (P − S) · e − from | z − b − bottom |
 * | region of a left face | (S − P) · e + to | z − b − bottom |
 * | floor | x | y |
 * | ceiling | −x | y |
 *
 * A face's triangles are cut along its regions' edges — in the face's own (s, t), where a region is
 * an axis-aligned rectangle — so each region's tiles start at its lower corner on the left of a
 * person facing it, wherever the region is on its wall and however the wall is turned in plan; and
 * since the mesh has its openings cut already, an opening is cut out of a region as it is out of
 * the face (18.5). The rest of the part — a wall's top, its ends, the reveals of its openings, the
 * sides of a thick floor, a tray's vertical step, whose coordinates this draft leaves undefined —
 * is a group with no surface.
 *
 * These are for drawing, not for normative output: positions arrive as Float32 metres and the
 * coordinates are doubles. `tileCoordinates` turns them into a texture's tile coordinates
 * `(s'/w, t'/h)`; a glTF exporter writes `u = s'/w`, `v = −t'/h` (glTF's v runs down its image),
 * three.js with `flipY` takes `v = t'/h` as it is.
 */
import { facingVector, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';
import { UNITS_PER_METRE, type MeshPart, type Vec3 } from './types.js';

export type Side = 'left' | 'right';

export type Surface =
  | { kind: 'face'; wall: string; side: Side }
  | { kind: 'region'; wall: string; side: Side; index: number }
  | { kind: 'floor'; room: string }
  | { kind: 'ceiling'; room: string };

export interface SurfaceGroup {
  /** The finished surface these triangles lie on; null for the rest of the part. */
  surface: Surface | null;
  /**
   * The material that finishes it (18.6): a region's, a face's resolved finish, a room's floor or
   * ceiling finish — and for a group with no surface, a ceiling's finish on its step, a slab's or a
   * roof's material. Null when nothing names one: the caller's default colour.
   */
  material: string | null;
  /** Unindexed triangles, three vertices each: metres relative to the mesh's origin, as the part's mesh. */
  positions: Float32Array;
  /** One normal per vertex, the triangle's. */
  normals: Float32Array;
  /** Each vertex's surface coordinates (s, t) in base units; empty for a group with no surface. */
  st: Float64Array;
}

/** A texture's placement on a surface (18.2): the size of one tile, where a tile's corner is and how the tiles are turned. */
export interface TilePlacement {
  size: readonly [number, number];
  offset?: readonly [number, number];
  /** Millionths of a degree, counter-clockwise as seen facing the surface. */
  rotation?: number;
}

/**
 * 18.3: a point's tile coordinates in tiles — `(s' / w, t' / h)` — from its surface coordinates.
 * The texel shown is at `frac` of each from the image's left and bottom edges.
 */
export function tileCoordinates(s: number, t: number, tex: TilePlacement): [number, number] {
  const [ox, oy] = tex.offset ?? [0, 0];
  const rotation = tex.rotation ?? 0;
  let fx = 1;
  let fy = 0;
  if (rotation !== 0) {
    const [bx, by] = facingVector(rotation);
    const len = Math.hypot(Number(bx), Number(by));
    fx = Number(bx) / len;
    fy = Number(by) / len;
  }
  const ds = s - ox;
  const dt = t - oy;
  return [(ds * fx + dt * fy) / tex.size[0], (dt * fx - ds * fy) / tex.size[1]];
}

// ── clipping in (s, t) ───────────────────────────────────────────────────────

/** A vertex being clipped: its position in metres and its face coordinates. */
interface V {
  p: [number, number, number];
  s: number;
  t: number;
}

type Poly = V[];

const lerp = (a: V, b: V, k: number): V => ({
  p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k],
  s: a.s + (b.s - a.s) * k,
  t: a.t + (b.t - a.t) * k,
});

/** Keep the part of a convex polygon where `sign · (coord − c) ≥ 0` (Sutherland–Hodgman, one plane). */
function clip(poly: Poly, axis: 's' | 't', c: number, sign: 1 | -1): Poly {
  const out: Poly = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = sign * (a[axis] - c);
    const db = sign * (b[axis] - c);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) out.push(lerp(a, b, da / (da - db)));
  }
  return out;
}

/** One square base unit: a sliver of less is the rounding of a cut along an edge, not surface. */
const MIN_AREA = 1;

/** The area of a polygon in (s, t), in square base units. */
function areaSt(poly: Poly): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.s * q.t - q.s * p.t;
  }
  return Math.abs(a) / 2;
}

interface Rect {
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}

/** A convex polygon split by a rectangle: the piece inside, and up to four convex pieces outside. */
function split(poly: Poly, r: Rect): { inside: Poly | null; outside: Poly[] } {
  const outside: Poly[] = [];
  let rest = poly;
  for (const [axis, c, sign] of [['s', r.s0, 1], ['s', r.s1, -1], ['t', r.t0, 1], ['t', r.t1, -1]] as const) {
    const out = clip(rest, axis, c, (-sign) as 1 | -1);
    if (out.length >= 3) outside.push(out);
    rest = clip(rest, axis, c, sign);
    if (rest.length < 3) return { inside: null, outside };
  }
  return { inside: rest, outside };
}

// ── grouping ─────────────────────────────────────────────────────────────────

class Group {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly st: number[] = [];
  constructor(
    readonly surface: Surface | null,
    readonly material: string | null,
  ) {}
  add(poly: Poly, n: readonly [number, number, number], region?: { ds: number; dt: number }): void {
    // A convex polygon, wound as the triangle it came from: a fan keeps the winding.
    for (let i = 1; i + 1 < poly.length; i++)
      for (const v of [poly[0]!, poly[i]!, poly[i + 1]!]) {
        this.pos.push(...v.p);
        this.nrm.push(...n);
        if (this.surface !== null) this.st.push(v.s - (region?.ds ?? 0), v.t - (region?.dt ?? 0));
      }
  }
  done(): SurfaceGroup {
    return { surface: this.surface, material: this.material, positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), st: new Float64Array(this.st) };
  }
}

/** How close to the face's own normal a triangle's must be to lie on that face. */
const ON_FACE = 0.98;

/**
 * A part's triangles by the finished surface each lies on, with surface coordinates (18.3) and the
 * material of each (18.6). Groups with no triangles are left out; the groups together are exactly
 * the part's triangles (cut where a region's edge crosses one).
 */
export function surfaceGroups(
  doc: FloorspecDocument,
  derived: Derived,
  part: Pick<MeshPart, 'kind' | 'id' | 'mesh' | 'material'>,
  origin: Vec3 = [0, 0, 0],
  unitsPerMetre: number = UNITS_PER_METRE,
): SurfaceGroup[] {
  const { positions: P, indices } = part.mesh;
  const k = unitsPerMetre;
  const groups = new Map<string, Group>();
  const group = (key: string, surface: Surface | null, material: string | null): Group => {
    let g = groups.get(key);
    if (g === undefined) groups.set(key, (g = new Group(surface, material)));
    return g;
  };
  /** A vertex in base units, in the document's own frame. */
  const world = (i: number): [number, number, number] => [P[3 * i]! * k + origin[0], P[3 * i + 1]! * k + origin[1], P[3 * i + 2]! * k + origin[2]];

  // What each kind of part needs to place a vertex on its surface.
  type Classify = (n: readonly [number, number, number]) => { key: string; surface: Surface | null; material: string | null; st?: (w: [number, number, number]) => [number, number]; rects?: { index: number; rect: Rect; material: string }[] };
  let classify: Classify;
  const rest = { key: 'rest', surface: null, material: part.material ?? null };

  if (part.kind === 'wall') {
    const w = get(doc.walls, part.id);
    const dw = derived.walls[part.id];
    const S = w && get(doc.junctions, w.start)?.position;
    const E = w && get(doc.junctions, w.end)?.position;
    if (!w || !dw || !S || !E) classify = () => rest;
    else {
      const dx = E[0] - S[0];
      const dy = E[1] - S[1];
      const len = Math.hypot(dx, dy);
      const e = [dx / len, dy / len] as const;
      // The left of the location line, looking from start to end (5.4).
      const left = [-e[1], e[0]] as const;
      const base = dw.baseElevation;
      const finishes = derived.finishes?.walls[part.id];
      const along = (q: [number, number, number]) => (q[0] - S[0]) * e[0] + (q[1] - S[1]) * e[1];
      const faces = {} as Record<Side, ReturnType<Classify>>;
      for (const side of ['left', 'right'] as const) {
        const f = finishes?.[side];
        const sgn = side === 'right' ? 1 : -1;
        faces[side] = {
          key: `face:${side}`,
          surface: { kind: 'face', wall: part.id, side },
          material: f?.material ?? null,
          st: (q) => [sgn * along(q), q[2] - base],
          // A region in the face's (s, t): along [from, to] is s in [from, to] on a right face and
          // in [−to, −from] on a left one, where s runs the other way.
          rects: (f?.regions ?? []).map((r, index) => ({
            index,
            material: r.material,
            rect: side === 'right' ? { s0: r.from, s1: r.to, t0: r.bottom, t1: r.top } : { s0: -r.to, s1: -r.from, t0: r.bottom, t1: r.top },
          })),
        };
      }
      classify = (n) => {
        const d = n[0] * left[0] + n[1] * left[1];
        return d > ON_FACE ? faces.left : d < -ON_FACE ? faces.right : { ...rest, material: null };
      };
    }
  } else if (part.kind === 'floor') {
    const material = derived.finishes?.rooms[part.id]?.floor ?? null;
    const floor = { key: 'floor', surface: { kind: 'floor', room: part.id } as Surface, material, st: (q: [number, number, number]): [number, number] => [q[0], q[1]] };
    classify = (n) => (n[2] > ON_FACE ? floor : { ...rest, material });
  } else if (part.kind === 'ceiling') {
    const material = derived.finishes?.rooms[part.id]?.ceiling ?? null;
    // Seen from below, and a vault's slopes too: their coordinates are the plan's (18.3).
    const ceiling = { key: 'ceiling', surface: { kind: 'ceiling', room: part.id } as Surface, material, st: (q: [number, number, number]): [number, number] => [-q[0], q[1]] };
    classify = (n) => (n[2] < -0.05 ? ceiling : { ...rest, key: 'step', material });
  } else classify = () => rest;

  for (let t = 0; t < indices.length; t += 3) {
    const ids = [indices[t]!, indices[t + 1]!, indices[t + 2]!] as const;
    const a = ids.map((i) => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!] as [number, number, number]);
    const u = [a[1]![0] - a[0]![0], a[1]![1] - a[0]![1], a[1]![2] - a[0]![2]];
    const v = [a[2]![0] - a[0]![0], a[2]![1] - a[0]![1], a[2]![2] - a[0]![2]];
    let n: [number, number, number] = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const nl = Math.hypot(...n) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    const c = classify(n);
    const st = c.st;
    if (st === undefined) {
      group(c.key, c.surface, c.material).add(a.map((p) => ({ p, s: 0, t: 0 })), n);
      continue;
    }
    let pieces: Poly[] = [ids.map((i, j) => {
      const [s, tt] = st(world(i));
      return { p: a[j]!, s, t: tt };
    })];
    for (const r of c.rects ?? []) {
      const next: Poly[] = [];
      for (const piece of pieces) {
        const { inside, outside } = split(piece, r.rect);
        next.push(...outside);
        if (inside !== null && areaSt(inside) > MIN_AREA) {
          const side = (c.surface as { side: Side }).side;
          // Region coordinates (18.3): from its lower corner on the left of a person facing it.
          group(`region:${side}:${String(r.index)}`, { kind: 'region', wall: part.id, side, index: r.index }, r.material).add(inside, n, { ds: r.rect.s0, dt: r.rect.t0 });
        }
      }
      pieces = next;
    }
    const g = group(c.key, c.surface, c.material);
    for (const piece of pieces) if (areaSt(piece) > MIN_AREA) g.add(piece, n);
  }
  return [...groups.values()].map((g) => g.done()).filter((g) => g.positions.length > 0);
}
