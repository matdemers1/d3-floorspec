/**
 * What a roof's gable end is clad in (FLR-T-12.38). A Core 0.4 gable end stands on its wall — the
 * gable's edge of the roof's footprint, normally on the wall's outer face (FLR-ADR-039) — and in a
 * real house it is that wall carried up to the roof: brick over a brick wall, siding over siding. So
 * a view draws a gable end in the finish of the wall under it, the face that looks out of the roof,
 * and only where no wall stands under it in its own default.
 *
 * The wall is found in plan, not exactly: a wall of the roof's level runs along the gable's edge
 * when that edge lies within one wall thickness of the wall's middle — on its outer face, on its
 * location line, or a little outside — and runs the same way (an arc wall segment by segment, so a
 * footprint whose edges approximate the arc finds it). The edge is sampled along its length; of the
 * walls under it, the one under most of it clads it. These are a view's choices, not the standard's
 * (a mesh is not normative, Core 0.5): doubles throughout.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';
import type { Cladding } from './types.js';

type P = readonly [number, number];

/** How many points along a gable's edge are tested for a wall under them. */
const SAMPLES = 32;

/** The cosine of the most a wall may turn from a gable's edge and still run along it: 30°, past an arc's chord. */
const ALONG = Math.cos(Math.PI / 6);

/** A wall's two faces and its middle, as polylines from its start to its end, and its thickness. */
interface WallLines {
  id: string;
  /** The line midway between its faces: one segment for a straight wall, its polyline's for an arc wall (21.4). */
  middle: P[];
  left: P[];
  thickness: number;
}

function linesOf(derived: Derived, id: string): WallLines | undefined {
  const dw = derived.walls[id];
  if (dw === undefined) return undefined;
  const left: P[] = dw.left !== undefined && dw.left.length >= 2 ? dw.left : [dw.startLeft, dw.endLeft];
  const right: P[] = dw.right !== undefined && dw.right.length === left.length ? dw.right : [dw.startRight, dw.endRight];
  if (right.length !== left.length) return undefined;
  const middle = left.map((l, i): P => [(l[0] + right[i]![0]) / 2, (l[1] + right[i]![1]) / 2]);
  const thickness = Math.hypot(dw.startLeft[0] - dw.startRight[0], dw.startLeft[1] - dw.startRight[1]);
  return thickness > 0 ? { id, middle, left, thickness } : undefined;
}

/** The nearest segment of a polyline to p: its distance, and the segment's unit direction. */
function nearest(line: readonly P[], p: P): { d: number; e: P; k: number } | undefined {
  let best: { d: number; e: P; k: number } | undefined;
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k]!;
    const b = line[k + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const ll = dx * dx + dy * dy;
    if (ll === 0) continue;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll));
    const d = Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1]);
    if (best === undefined || d < best.d) {
      const l = Math.sqrt(ll);
      best = { d, e: [dx / l, dy / l], k };
    }
  }
  return best;
}

/** Twice the signed area of a polygon: positive when it runs counter-clockwise. */
const area2 = (ring: readonly P[]): number => ring.reduce((s, a, i) => s + a[0] * ring[(i + 1) % ring.length]![1] - ring[(i + 1) % ring.length]![0] * a[1], 0);

/**
 * The wall a gable end of roof `roof` on footprint edge `edge` stands on, its face that looks out of
 * the roof, and that face's material — what 18.6 resolves it to (its own, its room's wall finish,
 * its outer layer's), else that layer's — or undefined when no wall of the roof's level runs along
 * the edge.
 */
export function gableCladding(doc: FloorspecDocument, derived: Derived, roof: string, edge: number): Cladding | undefined {
  const r = get(doc.roofs, roof);
  const fp = r?.footprint as readonly P[] | undefined;
  if (r === undefined || fp === undefined || fp.length < 3 || edge < 0 || edge >= fp.length) return undefined;
  const A = fp[edge]!;
  const B = fp[(edge + 1) % fp.length]!;
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (len === 0) return undefined;
  const e: P = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
  // Out of the roof: to the right of the edge on a counter-clockwise footprint, to its left on a clockwise one.
  const ccw = area2(fp) > 0;
  const out: P = ccw ? [e[1], -e[0]] : [-e[1], e[0]];

  let best: { wall: string; under: number; off: number; outward: number } | undefined;
  for (const id of Object.keys(derived.walls).sort()) {
    const w = get(doc.walls, id);
    if (w === undefined || w.level !== r.level) continue;
    const lines = linesOf(derived, id);
    if (lines === undefined) continue;
    let under = 0;
    let off = 0;
    let outward = 0;
    for (let s = 0; s < SAMPLES; s++) {
      const t = (s + 0.5) / SAMPLES;
      const p: P = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])];
      const n = nearest(lines.middle, p);
      if (n === undefined || n.d > lines.thickness || Math.abs(n.e[0] * e[0] + n.e[1] * e[1]) < ALONG) continue;
      under++;
      off += n.d;
      // The wall's left (5.4) on that segment, against the way out of the roof.
      outward += -n.e[1] * out[0] + n.e[0] * out[1];
    }
    if (under === 0) continue;
    const mean = off / under;
    if (best === undefined || under > best.under || (under === best.under && mean < best.off)) best = { wall: id, under, off: mean, outward };
  }
  if (best === undefined) return undefined;

  const side = best.outward >= 0 ? 'left' : 'right';
  const w = get(doc.walls, best.wall)!;
  const t = w.type === undefined ? undefined : get(doc.types, w.type);
  const layers = w.layers ?? (t?.kind === 'wallType' ? t.layers : undefined) ?? [];
  const layer = layers.length === 0 ? undefined : side === 'left' ? layers[0] : layers[layers.length - 1];
  const material = derived.finishes?.walls[best.wall]?.[side]?.material ?? layer?.material;
  return { wall: best.wall, side, ...(material !== undefined && { material }) };
}
