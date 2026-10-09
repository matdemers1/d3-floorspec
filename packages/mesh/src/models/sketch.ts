/**
 * A model's drawing board: pieces drawn in an element's own box and carried to the plan.
 *
 * Every model is drawn in the element's local frame (Core 13.1) measured from its box's least
 * corner: x from its back (0) to its front (X), y from its right (0) to its left (Y), z from its
 * bottom (0) to its top (Z) — the extents of its fallback box (12.6). A local point goes to the plan
 * through the box's own footprint, the four corners the engine derived and rounded (13.2): the
 * point's place across the box, carried bilinearly between them, rounded once. A point inside the
 * box therefore lands inside the footprint (to the half unit rounding moves it), whatever the frame's
 * facing, and the box's corners land exactly on the footprint's.
 *
 * Each piece is a closed solid of its own (a part): a block, an extrusion, or a solid of revolution.
 * Its points are deduplicated by value, so its faces share their edges and it is watertight.
 */
import { facingVector, type DerivedFallback } from '@floorspec/engine';
import { MeshBuilder, type P3 } from '../builder.js';
import type { Kernel } from '../kernel.js';
import type { ModelRole } from '../roles.js';
import { COS, SIDES, SIN } from './circle.js';

export type Axis = 'x' | 'y' | 'z';
type V2 = readonly [number, number];
type V3 = readonly [number, number, number];

/** A piece of a model: its name (unique in the element), what it is made of, and its solid. */
export interface Piece {
  name: string;
  role: ModelRole;
  b: MeshBuilder;
  /** A solid of revolution: one curved surface, which a view may draw without lines between its facets. */
  smooth: boolean;
}

/** The plan corners of the box's local (0, 0), (X, 0), (X, Y), (0, Y), from the derived footprint. */
export function corners(f: Pick<DerivedFallback, 'footprint'>, facing: number | undefined): [V2, V2, V2, V2] {
  const ring = f.footprint;
  const [fx, fy] = facing === undefined ? [1, 0] : facingVector(facing).map(Number) as [number, number];
  // The footprint starts at its least vertex (13.2); the corner the frame's x axis leaves from is
  // the one whose next edge runs most nearly along the facing.
  let best = 0;
  let most = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % 4]!;
    const d = (b[0] - a[0]) * fx + (b[1] - a[1]) * fy;
    if (d > most) {
      most = d;
      best = k;
    }
  }
  const at = (i: number): V2 => ring[(best + i) % 4]!;
  return [at(0), at(1), at(2), at(3)];
}

/**
 * Where (x, y, z), in local units measured from the box's least corner, lands in the plan: clamped
 * into the box first, so nothing a model draws leaves it.
 */
export function placer(c: readonly [V2, V2, V2, V2], bottom: number, X: number, Y: number, Z: number): (x: number, y: number, z: number) => P3 {
  const [c00, c10, c11, c01] = c;
  const ex = [c10[0] - c00[0], c10[1] - c00[1]];
  const ey = [c01[0] - c00[0], c01[1] - c00[1]];
  const exy = [c11[0] - c10[0] - c01[0] + c00[0], c11[1] - c10[1] - c01[1] + c00[1]];
  return (x, y, z) => {
    const u = Math.min(Math.max(x, 0), X) / X;
    const v = Math.min(Math.max(y, 0), Y) / Y;
    const w = Math.min(Math.max(z, 0), Z);
    return [Math.round(c00[0] + ex[0]! * u + ey[0]! * v + exy[0]! * u * v), Math.round(c00[1] + ex[1]! * u + ey[1]! * v + exy[1]! * u * v), bottom + Math.round(w)];
  };
}

/** (a, b) across an axis and h along it, as local (x, y, z): a right-handed turn of the axes, so a ring counter-clockwise in (a, b) faces +h. */
function along(axis: Axis, a: number, b: number, h: number): V3 {
  return axis === 'z' ? [a, b, h] : axis === 'x' ? [h, a, b] : [b, h, a];
}

const signedArea = (ring: readonly V2[]): number => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s;
};

export class Sketch {
  readonly pieces: Piece[] = [];
  private readonly names = new Set<string>();

  constructor(
    private readonly kernel: Kernel,
    private readonly place: (x: number, y: number, z: number) => P3,
    /** The box's extents: depth (x), width (y), height (z), base units. */
    readonly X: number,
    readonly Y: number,
    readonly Z: number,
  ) {}

  private piece(name: string, role: ModelRole, smooth = false): MeshBuilder {
    let n = name;
    for (let k = 2; this.names.has(n); k++) n = `${name}${String(k)}`;
    this.names.add(n);
    const b = new MeshBuilder(this.kernel);
    this.pieces.push({ name: n, role, b, smooth });
    return b;
  }

  /** A block from (x0, y0, z0) to (x1, y1, z1); nothing for one without volume. */
  box(name: string, role: ModelRole, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
    const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
    const [az, bz] = z0 < z1 ? [z0, z1] : [z1, z0];
    if (bx - ax < 2 || by - ay < 2 || bz - az < 2) return;
    this.extrude(name, role, 'z', [[ax, ay], [bx, ay], [bx, by], [ax, by]], az, bz);
  }

  /**
   * A polygon in the plane across `axis` — (x, y) across z, (y, z) across x, (z, x) across y —
   * from h0 to h1 along it, with holes; either winding.
   */
  extrude(name: string, role: ModelRole, axis: Axis, outer: readonly V2[], h0: number, h1: number, holes: readonly (readonly V2[])[] = []): void {
    if (outer.length < 3 || h1 - h0 < 2) return;
    const o = signedArea(outer) < 0 ? [...outer].reverse() : [...outer];
    const hs = holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : [...h]));
    const b = this.piece(name, role);
    const at = (p: V2, h: number): P3 => {
      const [x, y, z] = along(axis, p[0], p[1], h);
      return this.place(x, y, z);
    };
    const rings = [o, ...hs];
    b.face(rings.map((r) => r.map((p) => at(p, h1))));
    b.face(rings.map((r) => [...r].reverse().map((p) => at(p, h0))));
    for (const r of rings)
      for (let i = 0; i < r.length; i++) {
        const p = r[i]!;
        const q = r[(i + 1) % r.length]!;
        b.quad(at(p, h0), at(q, h0), at(q, h1), at(p, h1));
      }
  }

  /**
   * A solid of revolution about an axis through `centre` — (a, b) across it, as for `extrude` —
   * swept from a closed profile of (radius, height) points; a point at radius 0 is on the axis. Each
   * ring is an ellipse when `aspect` stretches it (a toilet's bowl).
   */
  lathe(name: string, role: ModelRole, axis: Axis, centre: V2, profile: readonly V2[], aspect: V2 = [1, 1]): void {
    if (profile.length < 3) return;
    const pr = signedArea(profile) < 0 ? [...profile].reverse() : [...profile];
    const b = this.piece(name, role, true);
    const ring = (p: V2): P3[] =>
      Array.from({ length: SIDES }, (_, k) => {
        const [x, y, z] = along(axis, centre[0] + p[0] * aspect[0] * COS[k]!, centre[1] + p[0] * aspect[1] * SIN[k]!, p[1]);
        return this.place(x, y, z);
      });
    const rings = pr.map(ring);
    for (let i = 0; i < pr.length; i++) {
      const j = (i + 1) % pr.length;
      if (pr[i]![0] === 0 && pr[j]![0] === 0) continue;
      const r0 = rings[i]!;
      const r1 = rings[j]!;
      for (let k = 0; k < SIDES; k++) {
        const l = (k + 1) % SIDES;
        b.quad(r0[k]!, r0[l]!, r1[l]!, r1[k]!);
      }
    }
  }

  /** A cylinder about an axis: radius r, from h0 to h1. */
  cylinder(name: string, role: ModelRole, axis: Axis, centre: V2, r: number, h0: number, h1: number): void {
    if (r < 2 || h1 - h0 < 2) return;
    this.lathe(name, role, axis, centre, [[0, h0], [r, h0], [r, h1], [0, h1]]);
  }

  /** A ring about an axis: radii r0 < r1, from h0 to h1 (a light's trim, a washer's door). */
  annulus(name: string, role: ModelRole, axis: Axis, centre: V2, r0: number, r1: number, h0: number, h1: number): void {
    if (r1 - r0 < 2 || h1 - h0 < 2) return;
    this.lathe(name, role, axis, centre, [[r0, h0], [r1, h0], [r1, h1], [r0, h1]]);
  }
}

/** An ellipse's 24 points about (cx, cy) with radii rx, ry: for an extrusion's outline. */
export function ellipse(cx: number, cy: number, rx: number, ry: number): V2[] {
  return Array.from({ length: SIDES }, (_, k): V2 => [cx + rx * COS[k]!, cy + ry * SIN[k]!]);
}

/** A rectangle with its corners cut at 45° by c: a softer outline for a basin or a tub. */
export function rounded(x0: number, y0: number, x1: number, y1: number, c: number): V2[] {
  const k = Math.max(0, Math.min(c, (x1 - x0) / 3, (y1 - y0) / 3));
  return [
    [x0 + k, y0],
    [x1 - k, y0],
    [x1, y0 + k],
    [x1, y1 - k],
    [x1 - k, y1],
    [x0 + k, y1],
    [x0, y1 - k],
    [x0, y0 + k],
  ];
}
