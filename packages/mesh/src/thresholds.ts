/**
 * Thresholds (FLR-T-12.20): the floor under a door or an empty (cased) opening.
 *
 * A room's floor is the prism of its room polygon (15.1), which stops at the faces of its walls; an
 * opening whose sill is its wall's base cuts the wall to the base. Between the two floors on either
 * side of the wall, under the opening, there is then nothing at all — a slit through the house
 * along the wall's thickness, the ground (or the level below) seen through every doorway.
 *
 * The threshold fills it: the plan polygon the opening's cut removes from its wall (walls.ts,
 * `cutPolygon`), split at the wall's location line, each half the floor of the room on its side —
 * the same top and bottom (15.1), a solid prism between them, or a surface facing up at its top for
 * a floor that declares no thickness. The room on a side is the one its face faces (18.6), or the
 * room whose polygon holds a point just past that face at the opening's middle. A side that faces
 * no room (outside the house) continues the other side's floor, so the doorway has one sill; an
 * opening with a room on neither side has no threshold.
 *
 * The cut's corners where its planes cross the wall's faces, and the location line, are rational
 * points for a wall that is not along an axis: each is rounded once to an integer (2.2), as the
 * engine rounds what it derives, so the threshold's volume is exact.
 *
 * Not built: an opening in an arc wall (21.6), whose location line is a polyline.
 */
import type { Derived, DerivedRoomPolygon, FloorspecDocument } from '@floorspec/engine';
import { dedupe, MeshBuilder, type P2 } from './builder.js';
import { clip, iarea2, type IPoint, type RPoint } from './exact.js';
import type { Kernel } from './kernel.js';
import { get } from './own.js';
import type { RawPart } from './part.js';
import { cutPolygon } from './walls.js';

type Side = 'left' | 'right';
type Point = readonly [number, number];

const I = (p: Point): IPoint => [BigInt(p[0]), BigInt(p[1])];

/** Base units past a wall's face that the room on that side is looked for: one millimetre. */
const PAST_FACE = 1280;

/** Is (x, y) inside the polygon (even–odd)? */
function inside(ring: readonly Point[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const inRoom = (r: DerivedRoomPolygon, x: number, y: number): boolean => inside(r.outer, x, y) && !r.holes.some((h) => inside(h, x, y));

/** The plan of an opening's threshold: its cut split at the location line, each half's corners rounded once. */
export interface ThresholdPlan {
  opening: string;
  wall: string;
  side: Side;
  ring: P2[];
}

/** The halves of every threshold's plan, before rooms are found: exported for the property tests. */
export function thresholdPlans(doc: FloorspecDocument, derived: Derived): ThresholdPlan[] {
  const out: ThresholdPlan[] = [];
  for (const oid of Object.keys(derived.openings).sort()) {
    const o = get(doc.openings, oid)!;
    const w = get(doc.walls, o.wall);
    const dw = derived.walls[o.wall];
    const dop = derived.openings[oid]!;
    if (w === undefined || dw === undefined || dw.polyline !== undefined || w.arc?.sagitta) continue;
    const t = o.fill === undefined ? undefined : get(doc.types, o.fill);
    if (t?.kind === 'windowType' || dop.sillElevation !== dw.baseElevation) continue;
    const ring = dedupe([dw.startRight, dw.endRight, dw.endLeft, dw.startLeft]).map(I);
    if (ring.length < 3 || iarea2(ring) <= 0n) continue;
    const S = I(get(doc.junctions, w.start)!.position);
    const E = I(get(doc.junctions, w.end)!.position);
    const d: IPoint = [E[0] - S[0], E[1] - S[1]];
    const s = I(dop.start);
    const e = I(dop.end);
    const c0 = d[0] * s[0] + d[1] * s[1];
    const c1 = d[0] * e[0] + d[1] * e[1];
    if (c1 <= c0) continue;
    const cut = cutPolygon(ring, d, c0, c1);
    const n: IPoint = [-d[1], d[0]];
    const ns = n[0] * S[0] + n[1] * S[1];
    for (const side of ['left', 'right'] as const) {
      const half: RPoint[] = cut.length < 3 ? [] : clip(cut, { a: n, c: ns, s: side === 'left' ? 1 : -1 });
      const r = dedupe(half.map((p): P2 => [Number(p[0].round()), Number(p[1].round())]));
      if (r.length < 3 || iarea2(r.map(I)) <= 0n) continue;
      out.push({ opening: oid, wall: o.wall, side, ring: r });
    }
  }
  return out;
}

/** The room each side of a wall faces at an opening: its finish's (18.6), or the one just past the face. */
function roomsBeside(doc: FloorspecDocument, derived: Derived, oid: string): Record<Side, string | undefined> {
  const o = get(doc.openings, oid)!;
  const w = get(doc.walls, o.wall)!;
  const dw = derived.walls[o.wall]!;
  const dop = derived.openings[oid]!;
  const S = get(doc.junctions, w.start)!.position;
  const E = get(doc.junctions, w.end)!.position;
  const len = Math.hypot(E[0] - S[0], E[1] - S[1]);
  const n = [-(E[1] - S[1]) / len, (E[0] - S[0]) / len] as const;
  const mid = [(dop.start[0] + dop.end[0]) / 2, (dop.start[1] + dop.end[1]) / 2] as const;
  const fin = derived.finishes?.walls[o.wall];
  const rooms = Object.keys(derived.rooms)
    .sort()
    .filter((r) => get(doc.rooms, r)?.level === w.level);
  const find = (side: Side): string | undefined => {
    const named = fin?.[side]?.room;
    if (named !== undefined) return named;
    const at = side === 'left' ? dw.startLeft : dw.startRight;
    const face = (at[0] - S[0]) * n[0] + (at[1] - S[1]) * n[1];
    const k = face + (side === 'left' ? PAST_FACE : -PAST_FACE);
    const x = mid[0] + k * n[0];
    const y = mid[1] + k * n[1];
    return rooms.find((r) => inRoom(derived.rooms[r]!, x, y));
  };
  return { left: find('left'), right: find('right') };
}

export function thresholdParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  if (!want('threshold') || derived.floors === undefined) return [];
  const out: RawPart[] = [];
  const beside = new Map<string, Record<Side, string | undefined>>();
  for (const t of thresholdPlans(doc, derived)) {
    let rooms = beside.get(t.opening);
    if (rooms === undefined) beside.set(t.opening, (rooms = roomsBeside(doc, derived, t.opening)));
    // A side outside the house continues the other side's floor.
    const room = rooms[t.side] ?? rooms[t.side === 'left' ? 'right' : 'left'];
    const fl = room === undefined ? undefined : derived.floors[room];
    if (room === undefined || fl === undefined) continue;
    const b = new MeshBuilder(kernel);
    const closed = fl.top > fl.bottom;
    if (closed) b.prism([t.ring], fl.bottom, fl.top);
    else b.sheet([t.ring], fl.top, 'up');
    out.push({
      kind: 'threshold',
      id: t.opening,
      level: get(doc.walls, t.wall)!.level,
      closed,
      ...(closed ? {} : { facing: 'up' as const }),
      threshold: { wall: t.wall, side: t.side, room },
      piece: t.side,
      exact: b,
    });
  }
  return out;
}
