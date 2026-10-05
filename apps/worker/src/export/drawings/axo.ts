/**
 * The sheet's 3D view (FLR-T-9.3): an isometric drawing of the building, cut away above the sheet's
 * level, from the engine's derived geometry.
 *
 * The 3D mesh and its renderer (FLR-T-7.4/7.5) do not exist yet, so this is drawn here as polygons:
 * every wall is the level's wall outline (the union of wall and junction pieces, so no seams show
 * between them) extruded from its derived base to its derived top, with each door and window cut
 * through at its derived sill and head and its reveals drawn; room floors and slabs are plates at
 * their derived elevations. Back faces are culled and the rest painted far to near (painter's
 * algorithm, by each face's depth along the view). When the mesh renderer lands, this view
 * switches to it; the panel, its place on the sheet and its caption stay.
 *
 * Projection: true isometric from the south-west, above — screen x = (x − y)/√2,
 * screen y (up) = (x + y + 2z)/√6, depth = (x + y − z)/√3. Floats are fine here: the view is
 * illustrative and no dimension is read from it.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { axes, mergeCollinear, unionOutline, type LevelPlan, type XY } from './plan.js';

export type Vec3 = readonly [number, number, number];

export interface AxoFace {
  /** Rings in screen space (y up): the first is the outline, any others are holes (even-odd). */
  readonly rings: readonly (readonly XY[])[];
  /** Grey level 0–255. */
  readonly shade: number;
  /** Draw the outline. */
  readonly stroke: boolean;
  readonly depth: number;
  /** Lower levels are drawn first, whatever their depth. */
  readonly level: number;
  /** Within a level: plates, then walls, then the tops of walls. */
  readonly layer: number;
}

const S2 = Math.SQRT2;
const S6 = Math.sqrt(6);
const S3 = Math.sqrt(3);

export const project = (p: Vec3): XY => [(p[0] - p[1]) / S2, (p[0] + p[1] + 2 * p[2]) / S6];
const depthOf = (pts: readonly Vec3[]): number => pts.reduce((s, p) => s + (p[0] + p[1] - p[2]) / S3, 0) / pts.length;

/** Facing the viewer (at −x, −y, +z): N · (−1, −1, 1) > 0. */
const facing = (n: Vec3): boolean => n[2] - n[0] - n[1] > 1e-9;

/** A planar polygon's unit normal (Newell's method), oriented towards the viewer. */
function normalOf(pts: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(x, y, z) || 1;
  const n: Vec3 = [x / l, y / l, z / l];
  return facing(n) ? n : [-n[0], -n[1], -n[2]];
}

/** A face's grey from its normal: tops lightest, south-facing light, west-facing darker. */
function shadeOf(n: Vec3): number {
  if (n[2] > 0.5) return 246;
  const len = Math.hypot(n[0], n[1]) || 1;
  const south = Math.max(0, -n[1] / len);
  const west = Math.max(0, -n[0] / len);
  return Math.round(236 * south + 196 * west + 220 * (1 - south - west > 0 ? 1 - south - west : 0));
}

interface Hole {
  t0: number;
  t1: number;
  z0: number;
  z1: number;
  reveals: Vec3[][];
}

/**
 * The isometric faces of the levels at or below `upTo` (by elevation): what a cutaway at that level
 * shows. `doc` and `derived` are the evaluated document and its derived geometry; `plans` are its
 * level plans (any order).
 */
export function axonometric(doc: FloorspecDocument, derived: Derived, plans: readonly LevelPlan[], upTo: string): AxoFace[] {
  const levels = doc.levels ?? {};
  const elevation = (id: string): number => levels[id]?.elevation ?? 0;
  const order = [...plans].sort((a, b) => elevation(a.levelId) - elevation(b.levelId) || (a.levelId < b.levelId ? -1 : 1));
  const cut = elevation(upTo);
  const faces: AxoFace[] = [];

  order.forEach((plan, levelIndex) => {
    if (elevation(plan.levelId) > cut) return;
    const lvl = levels[plan.levelId];
    const lvlBase = lvl?.elevation ?? 0;
    const lvlTop = lvlBase + (lvl?.height ?? 3_200_000);

    // ── plates: room floors and slabs ──
    for (const r of plan.rooms) {
      const z = derived.floors?.[r.id]?.top ?? lvlBase;
      const rings = [r.outer, ...r.holes].map((ring) => ring.map((p) => project([p[0], p[1], z])));
      faces.push({ rings, shade: 250, stroke: false, depth: depthOf(r.outer.map((p) => [p[0], p[1], z])), level: levelIndex, layer: 0 });
    }
    for (const s of plan.slabs) {
      const d = derived.slabs?.[s.id];
      const z = d?.top ?? lvlBase;
      faces.push({ rings: [s.outline.map((p) => project([p[0], p[1], z]))], shade: 232, stroke: true, depth: depthOf(s.outline.map((p) => [p[0], p[1], z])), level: levelIndex, layer: 0 });
    }

    // ── walls: the outline extruded, with openings cut through ──
    const wallElev = new Map<string, { base: number; top: number }>();
    for (const w of plan.scene.walls.values()) {
      const d = derived.walls[w.id];
      wallElev.set(w.id, { base: d?.baseElevation ?? lvlBase, top: d?.topElevation ?? lvlTop });
    }
    // Pieces carry the elevations of their wall; a junction fill takes the widest of the walls it meets.
    const pieceElev: { base: number; top: number }[] = [];
    const pieces: { ring: readonly (readonly [number, number])[]; exterior: boolean }[] = [];
    const vertexElev = new Map<string, { base: number; top: number }>();
    for (const w of plan.scene.walls.values()) {
      const e = wallElev.get(w.id)!;
      for (const v of w.outline) {
        const k = `${v[0]},${v[1]}`;
        const prior = vertexElev.get(k);
        vertexElev.set(k, prior === undefined ? e : { base: Math.min(prior.base, e.base), top: Math.max(prior.top, e.top) });
      }
    }
    for (const p of plan.pieces) {
      let e: { base: number; top: number } | undefined;
      for (const v of p.ring) {
        const ve = vertexElev.get(`${v[0]},${v[1]}`);
        if (ve) e = e === undefined ? ve : { base: Math.min(e.base, ve.base), top: Math.max(e.top, ve.top) };
      }
      pieceElev.push(e ?? { base: lvlBase, top: lvlTop });
      pieces.push(p);
    }
    // Group the pieces by elevation so walls of different heights each get their own outline.
    const groups = new Map<string, number[]>();
    pieceElev.forEach((e, i) => {
      const k = `${e.base}:${e.top}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });

    const openings = [...plan.scene.openings.values()];
    for (const [k, idx] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [base = lvlBase, top = lvlTop] = k.split(':').map(Number);
      const outline = mergeCollinear(unionOutline(idx.map((i) => pieces[i]!)));
      for (const e of outline) {
        const { u, len } = axes(e.a, e.b);
        if (len === 0) continue;
        const n: Vec3 = [u[1], -u[0], 0];
        if (!facing(n)) continue;
        // Openings whose face this edge lies on: their spans along the edge, sill to head.
        const holes: Hole[] = [];
        for (const o of openings) {
          const w = plan.scene.walls.get(o.wall);
          const d = derived.openings[o.id];
          if (!w || !d) continue;
          const wa = axes(w.start, w.end);
          const off = (p: XY): number => (p[0] - w.start[0]) * wa.n[0] + (p[1] - w.start[1]) * wa.n[1];
          const onLeft = Math.abs(off(e.a) - w.a) < 64 && Math.abs(off(e.b) - w.a) < 64;
          const onRight = Math.abs(off(e.a) + w.b) < 64 && Math.abs(off(e.b) + w.b) < 64;
          if (!onLeft && !onRight) continue;
          const t = (p: XY): number => (p[0] - e.a[0]) * u[0] + (p[1] - e.a[1]) * u[1];
          const t0 = Math.max(0, Math.min(t(o.start), t(o.end)));
          const t1 = Math.min(len, Math.max(t(o.start), t(o.end)));
          if (t1 - t0 <= 1) continue;
          const z0 = Math.max(base, d.sillElevation);
          const z1 = Math.min(top, d.headElevation);
          // Its reveals: the sill (seen from above) and the jamb that faces the viewer.
          const P = (p: XY, k: number, z: number): Vec3 => [p[0] + wa.n[0] * k, p[1] + wa.n[1] * k, z];
          const reveals: Vec3[][] = [];
          if (z0 > base) reveals.push([P(o.start, w.a, z0), P(o.end, w.a, z0), P(o.end, -w.b, z0), P(o.start, -w.b, z0)]);
          for (const [p, q] of [
            [o.start, o.end],
            [o.end, o.start],
          ] as const) {
            const ju = axes(p, q).u;
            if (facing([ju[0], ju[1], 0])) reveals.push([P(p, w.a, z0), P(p, -w.b, z0), P(p, -w.b, z1), P(p, w.a, z1)]);
          }
          holes.push({ t0, t1, z0, z1, reveals });
        }
        const at = (t: number, z: number): XY => project([e.a[0] + u[0] * t, e.a[1] + u[1] * t, z]);
        const rings: XY[][] = [[at(0, base), at(len, base), at(len, top), at(0, top)]];
        for (const h of holes) rings.push([at(h.t0, h.z0), at(h.t1, h.z0), at(h.t1, h.z1), at(h.t0, h.z1)]);
        const corners: Vec3[] = [
          [e.a[0], e.a[1], base],
          [e.b[0], e.b[1], top],
        ];
        const depth = depthOf(corners);
        // Reveals go just behind the face they are seen through.
        for (const h of holes)
          for (const r of h.reveals) {
            const rn = normalOf(r);
            faces.push({ rings: [r.map(project)], shade: shadeOf(rn), stroke: true, depth: depth + 1e-6, level: levelIndex, layer: 1 });
          }
        faces.push({ rings, shade: shadeOf(n), stroke: true, depth, level: levelIndex, layer: 1 });
      }
      // Wall tops, unstroked pieces under the stroked outline.
      for (const i of idx) {
        const ring = pieces[i]!.ring;
        faces.push({ rings: [ring.map((p) => project([p[0], p[1], top]))], shade: 246, stroke: false, depth: depthOf(ring.map((p) => [p[0], p[1], top])), level: levelIndex, layer: 2 });
      }
      for (const e of outline)
        faces.push({ rings: [[project([e.a[0], e.a[1], top]), project([e.b[0], e.b[1], top])]], shade: -1, stroke: true, depth: 0, level: levelIndex, layer: 3 });
    }

  });

  // Far to near; lower levels first; within a level plates, walls, then tops.
  return faces.sort((a, b) => a.level - b.level || a.layer - b.layer || b.depth - a.depth);
}
