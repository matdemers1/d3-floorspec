/**
 * Walls (chapter 5) with their openings (chapter 7) cut, the voids those cuts leave, and junction
 * fills.
 *
 * A wall is the prism of its outline — the quadrilateral of its rounded face ends (5.7) — from its
 * base to its top (5.9); Core's tops are flat. Each opening cuts the box between the two vertical
 * planes square to the wall's location line through its derived start and end points (7.4), from
 * its sill elevation to its head elevation, through the whole thickness: manifold-3d subtracts the
 * cuts from the prism, and intersects each with the prism for the opening's own void.
 *
 * The planes are exact: the start and end points are integers and the planes' normal is the wall's
 * integer direction, so every strip corner is an integer point. Each wall is built in a local frame
 * at its outline's first vertex and base, which keeps every coordinate manifold-3d sees small.
 */
import type { Derived, FloorspecDocument, Wall } from '@floorspec/engine';
import { get } from './own.js';
import { dedupe, MeshBuilder } from './builder.js';
import { area2, clip, extent, gcd, iarea2, remainder, rpoint, type HalfPlane, type IPoint, type RPoint } from './exact.js';
import { scoped, type Kernel, type Manifold } from './kernel.js';
import type { RawPart } from './part.js';
import type { Box3 } from './types.js';

const I = (p: readonly [number, number]): IPoint => [BigInt(p[0]), BigInt(p[1])];

interface Cut {
  id: string;
  /** The strip's corners, counter-clockwise, integers. */
  strip: IPoint[];
  /** d · start and d · end: the strip is c0 ≤ d · P ≤ c1. */
  c0: bigint;
  c1: bigint;
  sill: number;
  head: number;
}

/** The layer materials of a wall's effective layers (8.2, 8.3). */
function layersOf(doc: FloorspecDocument, w: Wall): (string | null)[] | undefined {
  const t = w.type === undefined ? undefined : get(doc.types, w.type);
  const layers = w.layers ?? (t?.kind === 'wallType' ? t.layers : undefined);
  return layers?.map((l) => l.material ?? null);
}

const slab = (d: IPoint, lo: bigint | undefined, hi: bigint | undefined): HalfPlane[] => [
  ...(lo === undefined ? [] : [{ a: d, c: lo, s: 1 as const }]),
  ...(hi === undefined ? [] : [{ a: d, c: hi, s: -1 as const }]),
];

const clipAll = (poly: readonly RPoint[], hs: readonly HalfPlane[]): RPoint[] => hs.reduce<RPoint[]>((p, h) => (p.length ? clip(p, h) : p), [...poly]);

/** Grow a box by a rational plan extent and an integer z range. */
function grow(box: Box3 | undefined, e: NonNullable<ReturnType<typeof extent>>, z0: bigint, z1: bigint): Box3 {
  const min: [number, number, number] = [e.min[0].toNumber(), e.min[1].toNumber(), Number(z0)];
  const max: [number, number, number] = [e.max[0].toNumber(), e.max[1].toNumber(), Number(z1)];
  if (!box) return { min, max };
  return {
    min: [Math.min(box.min[0], min[0]), Math.min(box.min[1], min[1]), Math.min(box.min[2], min[2])],
    max: [Math.max(box.max[0], max[0]), Math.max(box.max[1], max[1]), Math.max(box.max[2], max[2])],
  };
}

/**
 * The exact box of the regularized solid prism − ∪ cuts: the outline is cut into slabs at every
 * strip's planes; in each slab the same openings remove the same elevations everywhere, so the slab
 * contributes its plan extent and the least and greatest elevation left in it.
 */
export function wallBox(ring: readonly IPoint[], d: IPoint, base: bigint, top: bigint, cuts: readonly Cut[]): Box3 | undefined {
  const poly = ring.map(rpoint);
  const breaks = [...new Set(cuts.flatMap((c) => [c.c0, c.c1]))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bounds: (bigint | undefined)[] = [undefined, ...breaks, undefined];
  let box: Box3 | undefined;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    const piece = clipAll(poly, slab(d, lo, hi));
    if (piece.length < 3 || area2(piece).sign() === 0) continue;
    const over = cuts.filter((c) => (lo !== undefined && c.c0 <= lo) && (hi !== undefined && c.c1 >= hi));
    const left = remainder(base, top, over.map((c) => [BigInt(c.sill), BigInt(c.head)] as const));
    if (!left.length) continue;
    box = grow(box, extent(piece)!, left[0]![0], left[left.length - 1]![1]);
  }
  return box;
}

/** The exact plan polygon an opening's cut removes from its wall: the outline clipped to the strip. */
export function cutPolygon(ring: readonly IPoint[], d: IPoint, c0: bigint, c1: bigint): RPoint[] {
  return clipAll(ring.map(rpoint), slab(d, c0, c1));
}

export function wallParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  const out: RawPart[] = [];
  const { Manifold } = kernel;
  const openingsOf = new Map<string, string[]>();
  for (const oid of Object.keys(derived.openings).sort()) {
    const o = get(doc.openings, oid)!;
    openingsOf.set(o.wall, [...(openingsOf.get(o.wall) ?? []), oid]);
  }

  if (want('wall') || want('opening'))
    for (const id of Object.keys(derived.walls).sort()) {
      const w = get(doc.walls, id)!;
      const dw = derived.walls[id]!;
      const ring2 = dedupe([dw.startRight, dw.endRight, dw.endLeft, dw.startLeft]);
      const ring = ring2.map(I);
      if (ring.length < 3 || iarea2(ring) <= 0n) continue;
      const base = dw.baseElevation;
      const top = dw.topElevation;
      const S = I(get(doc.junctions, w.start)!.position);
      const E = I(get(doc.junctions, w.end)!.position);
      const d: IPoint = [E[0] - S[0], E[1] - S[1]];
      const g = gcd(d[0], d[1]);
      const n: IPoint = [-d[1] / g, d[0] / g];
      const nLen = Math.hypot(Number(n[0]), Number(n[1]));
      // How far the outline reaches from the location line, with a margin: the strip spans it.
      const reach = Math.max(...ring.map((V) => Math.abs(Number(n[0] * (V[0] - S[0]) + n[1] * (V[1] - S[1]))) / nLen));

      const cuts: Cut[] = [];
      for (const oid of openingsOf.get(id) ?? []) {
        const dop = derived.openings[oid]!;
        const s = I(dop.start);
        const e = I(dop.end);
        const c0 = d[0] * s[0] + d[1] * s[1];
        const c1 = d[0] * e[0] + d[1] * e[1];
        if (c1 <= c0) continue; // an opening so narrow that its rounded ends meet cuts nothing
        const off = Math.abs(Number(n[0] * (s[0] - S[0]) + n[1] * (s[1] - S[1]))) / nLen;
        const k = BigInt(Math.ceil((reach + off + 2) / nLen));
        const at = (p: IPoint, m: bigint): IPoint => [p[0] + m * n[0], p[1] + m * n[1]];
        let strip = [at(s, k), at(s, -k), at(e, -k), at(e, k)];
        if (iarea2(strip) < 0n) strip = strip.reverse();
        cuts.push({ id: oid, strip, c0, c1, sill: dop.sillElevation, head: dop.headElevation });
      }

      const O = ring2[0]!;
      const local = (p: IPoint): [number, number] => [Number(p[0]) - O[0], Number(p[1]) - O[1]];
      const origin = [O[0], O[1], base] as const;
      const layers = layersOf(doc, w);
      const parts = scoped((keep) => {
        const made: RawPart[] = [];
        const prism = keep(Manifold.extrude([ring.map(local)], top - base));
        const boxes = cuts.map((c) => keep(keep(Manifold.extrude([c.strip.map(local)], c.head - c.sill)).translate(0, 0, c.sill - base)));
        if (want('wall')) {
          const box = wallBox(ring, d, BigInt(base), BigInt(top), cuts);
          const solid: Manifold = boxes.length ? Manifold.difference([prism, ...boxes]) : prism.translate(0, 0, 0);
          if (box) made.push({ kind: 'wall', id, level: w.level, closed: true, ...(layers && { layers }), manifold: solid, origin, box });
          else solid.delete();
        }
        if (want('opening'))
          cuts.forEach((c, i) => {
            const poly = cutPolygon(ring, d, c.c0, c.c1);
            if (poly.length < 3 || area2(poly).sign() === 0) return;
            const e = extent(poly)!;
            const o = get(doc.openings, c.id)!;
            const t = o.fill === undefined ? undefined : get(doc.types, o.fill);
            const category = t?.kind === 'doorType' ? 'door' : t?.kind === 'windowType' ? 'window' : 'empty';
            made.push({
              kind: 'opening',
              id: c.id,
              level: w.level,
              closed: true,
              opening: { category, wall: id, ...(o.fill !== undefined && { fill: o.fill }) },
              manifold: prism.intersect(boxes[i]!),
              origin,
              box: grow(undefined, e, BigInt(c.sill), BigInt(c.head)),
            });
          });
        return made;
      });
      out.push(...parts);
    }

  if (want('junctionFill'))
    for (const jid of Object.keys(derived.junctionFills).sort()) {
      const fill = derived.junctionFills[jid]!;
      const j = get(doc.junctions, jid)!;
      const walls = Object.keys(derived.walls).filter((wid) => {
        const w = get(doc.walls, wid)!;
        return w.start === jid || w.end === jid;
      });
      if (!walls.length) continue;
      const base = Math.min(...walls.map((wid) => derived.walls[wid]!.baseElevation));
      const top = Math.max(...walls.map((wid) => derived.walls[wid]!.topElevation));
      const b = new MeshBuilder(kernel);
      b.prism([fill], base, top);
      out.push({ kind: 'junctionFill', id: jid, level: j.level, closed: true, exact: b });
    }
  return out;
}

