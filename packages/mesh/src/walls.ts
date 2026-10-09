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
 *
 * An arc wall (Core 0.4, chapter 21) is the prism of its outline through its face vertices (21.4): a
 * curved solid of many flat faces, as the polyline it follows. An opening in it stands on its chord
 * (21.6), so its cut is square to the chord, and reaches across the wall's thickness and the bow of the
 * wall past the chord — no further, so it never touches another part of the curve.
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

/** A wall's thickness: the sum of its effective layers (5.4). */
function thicknessOf(doc: FloorspecDocument, w: Wall): number {
  const t = w.type === undefined ? undefined : get(doc.types, w.type);
  const layers = w.layers ?? (t?.kind === 'wallType' ? t.layers : undefined);
  return (layers ?? []).reduce((s, l) => s + l.thickness, 0);
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

/** A flat roof with a thickness: a slab from `under` to its eave over its eave outline (Core 16.3, 16.4.1). */
export interface FlatSlab {
  readonly outline: readonly (readonly [number, number])[];
  readonly under: number;
  readonly eave: number;
}

/** Each level's flat roofs that have a thickness, by level. */
export function flatSlabs(doc: FloorspecDocument, derived: Derived): Map<string, FlatSlab[]> {
  const out = new Map<string, FlatSlab[]>();
  for (const id of Object.keys(derived.roofs ?? {}).sort()) {
    const r = derived.roofs![id]!;
    const roof = get(doc.roofs, id)!;
    const t = roof.thickness ?? 0;
    if (r.kind !== 'flat' || r.surface === null || t <= 0) continue;
    out.set(roof.level, [...(out.get(roof.level) ?? []), { outline: r.outline, under: r.eave - t, eave: r.eave }]);
  }
  return out;
}

/** True when (x, y) is inside the polygon or within a base unit of its boundary. */
function covers(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    const dx = xj - xi;
    const dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / len2));
    if (Math.hypot(x - (xi + u * dx), y - (yi + u * dy)) <= 1) return true;
    if (yi > y !== yj > y && x < (dx * (y - yi)) / dy + xi) inside = !inside;
  }
  return inside;
}

/**
 * Where a wall's solid stops: at the underside of a flat roof of its level whose slab would hold its
 * top — the wall standing wholly under the roof's eave outline — and otherwise at its own top. A flat
 * roof is its thickness hung below its eave, and a level's walls rise to the eave by default, so
 * without this their tops lie in the roof's surface and show through it (FLR-T-12.12). The wall's
 * derived top is unchanged; only the solid is drawn short of the roof that covers it.
 */
export function solidTop(slabs: readonly FlatSlab[] | undefined, plan: readonly (readonly [number, number])[], base: number, top: number): number {
  for (const s of slabs ?? [])
    if (top > s.under && top <= s.eave && s.under > base && plan.every(([x, y]) => covers(s.outline, x, y))) return s.under;
  return top;
}

export function wallParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  const out: RawPart[] = [];
  const slabs = flatSlabs(doc, derived);
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
      const ring2 = dedupe([dw.startRight, ...(dw.right ?? []), dw.endRight, dw.endLeft, ...[...(dw.left ?? [])].reverse(), dw.startLeft]);
      const arc = dw.polyline !== undefined && w.arc !== undefined;
      const ring = ring2.map(I);
      if (ring.length < 3 || iarea2(ring) <= 0n) continue;
      const base = dw.baseElevation;
      const top = solidTop(slabs.get(w.level), ring2, base, dw.topElevation);
      const S = I(get(doc.junctions, w.start)!.position);
      const E = I(get(doc.junctions, w.end)!.position);
      const d: IPoint = [E[0] - S[0], E[1] - S[1]];
      const g = gcd(d[0], d[1]);
      const n: IPoint = [-d[1] / g, d[0] / g];
      const nLen = Math.hypot(Number(n[0]), Number(n[1]));
      // How far the outline reaches from the location line, with a margin: the strip spans it.
      const reach = Math.max(...ring.map((V) => Math.abs(Number(n[0] * (V[0] - S[0]) + n[1] * (V[1] - S[1]))) / nLen));

      const cuts: (Cut & { d: IPoint; n: IPoint; across: [bigint, bigint] })[] = [];
      for (const oid of openingsOf.get(id) ?? []) {
        const dop = derived.openings[oid]!;
        const s = I(dop.start);
        const e = I(dop.end);
        // On an arc wall, square to the opening's chord (21.6); otherwise to the wall's direction.
        const dc: IPoint = arc ? [e[0] - s[0], e[1] - s[1]] : d;
        if (arc && dc[0] === 0n && dc[1] === 0n) continue;
        const gc = gcd(dc[0], dc[1]);
        const nc: IPoint = arc ? [-dc[1] / gc, dc[0] / gc] : n;
        const ncLen = Math.hypot(Number(nc[0]), Number(nc[1]));
        const c0 = dc[0] * s[0] + dc[1] * s[1];
        const c1 = dc[0] * e[0] + dc[1] * e[1];
        if (c1 <= c0) continue; // an opening so narrow that its rounded ends meet cuts nothing
        let k: bigint;
        if (arc) {
          const c = Math.hypot(Number(d[0]), Number(d[1]));
          const h = Math.abs(w.arc!.sagitta);
          const R = (c * c + 4 * h * h) / (8 * h);
          const l = Math.hypot(Number(dc[0]), Number(dc[1]));
          const bow = R - Math.sqrt(Math.max(R * R - (l * l) / 4, 0));
          k = BigInt(Math.ceil((thicknessOf(doc, w) + bow + 2) / ncLen));
        } else {
          const off = Math.abs(Number(n[0] * (s[0] - S[0]) + n[1] * (s[1] - S[1]))) / nLen;
          k = BigInt(Math.ceil((reach + off + 2) / nLen));
        }
        const at = (p: IPoint, m: bigint): IPoint => [p[0] + m * nc[0], p[1] + m * nc[1]];
        let strip = [at(s, k), at(s, -k), at(e, -k), at(e, k)];
        if (iarea2(strip) < 0n) strip = strip.reverse();
        const ns = nc[0] * s[0] + nc[1] * s[1];
        const nn = nc[0] * nc[0] + nc[1] * nc[1];
        cuts.push({ id: oid, strip, c0, c1, sill: dop.sillElevation, head: dop.headElevation, d: dc, n: nc, across: [ns - k * nn, ns + k * nn] });
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
          // An arc wall's cuts are square to different chords: its box is its outline's, base to top.
          const box = arc ? grow(undefined, extent(ring.map(rpoint))!, BigInt(base), BigInt(top)) : wallBox(ring, d, BigInt(base), BigInt(top), cuts);
          const solid: Manifold = boxes.length ? Manifold.difference([prism, ...boxes]) : prism.translate(0, 0, 0);
          if (box) made.push({ kind: 'wall', id, level: w.level, closed: true, ...(layers && { layers }), manifold: solid, origin, box });
          else solid.delete();
        }
        if (want('opening'))
          cuts.forEach((c, i) => {
            const poly = arc
              ? clipAll(ring.map(rpoint), [
                  ...slab(c.d, c.c0, c.c1),
                  ...slab(c.n, c.across[0], c.across[1]),
                ])
              : cutPolygon(ring, d, c.c0, c.c1);
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
      const top = solidTop(slabs.get(j.level), fill, base, Math.max(...walls.map((wid) => derived.walls[wid]!.topElevation)));
      const b = new MeshBuilder(kernel);
      b.prism([fill], base, top);
      out.push({ kind: 'junctionFill', id: jid, level: j.level, closed: true, exact: b });
    }
  return out;
}

