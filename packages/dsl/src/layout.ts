/**
 * Layout: relations resolve to rectangles, and rectangles to the plane graph of a level.
 *
 * Every room is an axis-aligned rectangle whose sides are wall location lines. A relation fixes one
 * coordinate exactly — `east-of dining` puts the room's west side on dining's east side — and its
 * alignment, or a second relation, fixes the other. Everything is an exact integer of base units
 * (FLR-ADR-004); there is no tolerance anywhere.
 *
 * The plane graph: every rectangle side is split at every rectangle corner lying inside it, and
 * equal pieces are merged. Two rooms can share only one piece (rectangles do not overlap), so
 * "the wall between A and B" is always one wall, and every junction a T needs is a corner.
 */
import { DslError, type Pos } from './diagnostics.js';
import type { Direction, Edge, Placement, Side } from './syntax.js';

export interface Rect {
  readonly x0: bigint;
  readonly y0: bigint;
  readonly x1: bigint;
  readonly y1: bigint;
}

export interface RoomSpec {
  readonly key: string;
  readonly handle: string;
  readonly width: bigint;
  readonly depth: bigint;
  readonly placements: readonly Placement[];
  readonly level: string;
  readonly pos: Pos;
}

/** A constraint on one coordinate of a room: its min edge (x0 or y0) is `base`'s edge plus an offset. */
interface Constraint {
  /** The room whose rectangle the value depends on, or none for `at`. */
  readonly of: string | undefined;
  readonly value: (r: Rect | undefined) => bigint;
  readonly pos: Pos;
  readonly explicit: boolean;
  readonly describe: string;
}

const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolve every room's rectangle. `find` resolves a handle to a room key (or throws). The first room
 * of each level with no placement is at the origin; any other room needs one.
 */
export function resolveRects(rooms: readonly RoomSpec[], find: (name: string, pos: Pos) => string): Map<string, Rect> {
  const byKey = new Map(rooms.map((r) => [r.key, r]));
  const axes = new Map<string, { x: Constraint[]; y: Constraint[] }>();
  const firstOfLevel = new Set<string>();
  for (const room of rooms) {
    if (!firstOfLevel.has(room.level)) {
      firstOfLevel.add(room.level);
      if (room.placements.length === 0) {
        axes.set(room.key, {
          x: [{ of: undefined, value: () => 0n, pos: room.pos, explicit: true, describe: 'the origin' }],
          y: [{ of: undefined, value: () => 0n, pos: room.pos, explicit: true, describe: 'the origin' }],
        });
        continue;
      }
    }
    if (room.placements.length === 0)
      throw new DslError(`room ${room.handle} has no position: give it at <x>,<y>, or place it east-of, west-of, north-of or south-of another room`, room.pos, 'FS-DSL-LAYOUT');
    const x: Constraint[] = [];
    const y: Constraint[] = [];
    for (const p of room.placements) {
      if (p.kind === 'at') {
        x.push({ of: undefined, value: () => p.x, pos: p.pos, explicit: true, describe: 'at' });
        y.push({ of: undefined, value: () => p.y, pos: p.pos, explicit: true, describe: 'at' });
        continue;
      }
      const of = find(p.of.name, p.of.pos);
      if (of === room.key) throw new DslError(`room ${room.handle} cannot be placed against itself`, p.of.pos, 'FS-DSL-LAYOUT');
      const [main, cross] = relation(p.dir, p.align?.edge, room, of, p.pos, p.of.name);
      (p.dir === 'east-of' || p.dir === 'west-of' ? x : y).push(main);
      (p.dir === 'east-of' || p.dir === 'west-of' ? y : x).push(cross);
    }
    axes.set(room.key, { x, y });
  }

  const out = new Map<string, Rect>();
  const state = new Map<string, 'visiting' | 'done'>();
  const choose = (room: RoomSpec, cs: Constraint[], axis: 'x' | 'y'): Constraint[] => {
    const explicit = cs.filter((c) => c.explicit);
    if (explicit.length > 0) return explicit;
    // Only implicit alignments: they must agree, which is checked when the values are known.
    if (cs.length === 0) throw new DslError(`room ${room.handle} has no ${axis === 'x' ? 'east–west' : 'north–south'} position`, room.pos, 'FS-DSL-LAYOUT');
    return cs;
  };
  const resolve = (key: string, via: Pos): Rect => {
    const done = out.get(key);
    if (done) return done;
    const room = byKey.get(key)!;
    if (state.get(key) === 'visiting') throw new DslError(`the placement of room ${room.handle} depends on itself`, via, 'FS-DSL-LAYOUT');
    state.set(key, 'visiting');
    const a = axes.get(key)!;
    const value = (cs: Constraint[], axis: 'x' | 'y'): bigint => {
      const chosen = choose(room, cs, axis);
      let v: bigint | undefined;
      let first: Constraint | undefined;
      for (const c of chosen) {
        const w = c.value(c.of === undefined ? undefined : resolve(c.of, c.pos));
        if (v === undefined) {
          v = w;
          first = c;
        } else if (v !== w) {
          const implicit = !c.explicit;
          throw new DslError(
            implicit
              ? `room ${room.handle}'s ${axis === 'x' ? 'east–west' : 'north–south'} position is ambiguous: ${first!.describe} and ${c.describe} disagree; say "aligned …" or add a relation for that axis`
              : `room ${room.handle} cannot be both ${first!.describe} and ${c.describe}: they put it at different ${axis === 'x' ? 'east–west' : 'north–south'} positions`,
            c.pos,
            'FS-DSL-LAYOUT',
          );
        }
      }
      return v!;
    };
    const x0 = value(a.x, 'x');
    const y0 = value(a.y, 'y');
    const r: Rect = { x0, y0, x1: x0 + room.width, y1: y0 + room.depth };
    state.set(key, 'done');
    out.set(key, r);
    return r;
  };
  for (const room of rooms) resolve(room.key, room.pos);

  // Rooms on one level must not overlap.
  const byLevel = new Map<string, RoomSpec[]>();
  for (const r of rooms) byLevel.set(r.level, [...(byLevel.get(r.level) ?? []), r]);
  for (const list of byLevel.values())
    for (let i = 0; i < list.length; i++)
      for (let j = 0; j < i; j++) {
        const a = out.get(list[j]!.key)!;
        const b = out.get(list[i]!.key)!;
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1)
          throw new DslError(`room ${list[i]!.handle} overlaps room ${list[j]!.handle}`, list[i]!.pos, 'FS-DSL-LAYOUT');
      }
  return out;
}

/** The constraint a relation puts on its own axis, and the alignment it puts on the other. */
function relation(dir: Direction, edge: Edge | undefined, room: RoomSpec, of: string, pos: Pos, ofName: string): [Constraint, Constraint] {
  const main: Constraint = {
    of,
    pos,
    explicit: true,
    describe: `${dir} ${ofName}`,
    value: (r) => (dir === 'east-of' ? r!.x1 : dir === 'west-of' ? r!.x0 - room.width : dir === 'north-of' ? r!.y1 : r!.y0 - room.depth),
  };
  const horizontal = dir === 'east-of' || dir === 'west-of';
  const size = horizontal ? room.depth : room.width;
  const e: Edge = edge ?? (horizontal ? 'south' : 'west');
  const cross: Constraint = {
    of,
    pos,
    explicit: edge !== undefined,
    describe: `aligned ${e} with ${ofName}`,
    value: (r) => {
      const lo = horizontal ? r!.y0 : r!.x0;
      const hi = horizontal ? r!.y1 : r!.x1;
      if (e === 'center') {
        const twice = lo + hi - size;
        if (twice % 2n !== 0n) throw new DslError(`room ${room.handle} cannot be centred on ${ofName} exactly: their sizes differ by an odd number of base units`, pos, 'FS-DSL-LAYOUT');
        return twice / 2n;
      }
      return e === 'south' || e === 'west' ? lo : hi - size;
    },
  };
  return [main, cross];
}

// ── the plane graph ────────────────────────────────────────────────────────────

export type Point = readonly [bigint, bigint];

/** One edge of the plane graph: a piece of one or two rooms' sides, from `a` to `b` (a < b). */
export interface Piece {
  readonly axis: 'h' | 'v';
  /** The fixed coordinate: y for a horizontal piece, x for a vertical one. */
  readonly at: bigint;
  /** The running coordinate's interval, lo < hi. */
  readonly lo: bigint;
  readonly hi: bigint;
  /** The room on the high side (north of a horizontal piece, east of a vertical one). */
  readonly high: string | undefined;
  /** The room on the low side (south, west). */
  readonly low: string | undefined;
}

export const pieceKey = (p: Pick<Piece, 'axis' | 'at' | 'lo' | 'hi'>): string => `${p.axis}:${p.at}:${p.lo}:${p.hi}`;
export const startOf = (p: Piece): Point => (p.axis === 'h' ? [p.lo, p.at] : [p.at, p.lo]);
export const endOf = (p: Piece): Point => (p.axis === 'h' ? [p.hi, p.at] : [p.at, p.hi]);

/** Every piece of the plane graph of these rectangles, sorted (axis, at, lo). */
export function pieces(rects: ReadonlyMap<string, Rect>): Piece[] {
  const corners: Point[] = [];
  for (const r of rects.values()) corners.push([r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]);
  // Corners by line, for splitting.
  const onH = new Map<bigint, bigint[]>();
  const onV = new Map<bigint, bigint[]>();
  for (const [x, y] of corners) {
    onH.set(y, [...(onH.get(y) ?? []), x]);
    onV.set(x, [...(onV.get(x) ?? []), y]);
  }
  const acc = new Map<string, { axis: 'h' | 'v'; at: bigint; lo: bigint; hi: bigint; high?: string; low?: string }>();
  const add = (axis: 'h' | 'v', at: bigint, lo: bigint, hi: bigint, key: string, side: 'high' | 'low'): void => {
    const cuts = [...new Set([lo, hi, ...(axis === 'h' ? onH : onV).get(at)!.filter((c) => c > lo && c < hi)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i + 1 < cuts.length; i++) {
      const k = pieceKey({ axis, at, lo: cuts[i]!, hi: cuts[i + 1]! });
      const p = acc.get(k) ?? { axis, at, lo: cuts[i]!, hi: cuts[i + 1]! };
      p[side] = key;
      acc.set(k, p);
    }
  };
  for (const [key, r] of [...rects].sort(([a], [b]) => cmpKey(a, b))) {
    add('h', r.y0, r.x0, r.x1, key, 'high'); // south side: the room is north of it
    add('h', r.y1, r.x0, r.x1, key, 'low');
    add('v', r.x0, r.y0, r.y1, key, 'high'); // west side: the room is east of it
    add('v', r.x1, r.y0, r.y1, key, 'low');
  }
  const cmpB = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...acc.values()]
    .map((p) => ({ axis: p.axis, at: p.at, lo: p.lo, hi: p.hi, high: p.high, low: p.low }))
    .sort((a, b) => (a.axis !== b.axis ? (a.axis === 'h' ? -1 : 1) : cmpB(a.at, b.at) || cmpB(a.lo, b.lo)));
}

/** The pieces on one side of a room, in order along it. */
export function sidePieces(all: readonly Piece[], key: string, r: Rect, side: Side): Piece[] {
  return all.filter((p) => {
    if (side === 'south') return p.axis === 'h' && p.at === r.y0 && p.high === key;
    if (side === 'north') return p.axis === 'h' && p.at === r.y1 && p.low === key;
    if (side === 'west') return p.axis === 'v' && p.at === r.x0 && p.high === key;
    return p.axis === 'v' && p.at === r.x1 && p.low === key;
  });
}

/** The direction a piece's wall is drawn: exterior walls clockwise (their exterior on the left, Core §5.4), others low to high. */
export function oriented(p: Piece): { from: Point; to: Point } {
  const s = startOf(p);
  const e = endOf(p);
  // Low to high, the left is north of a horizontal piece and west of a vertical one, i.e. the
  // `high` side of a horizontal piece and the `low` side of a vertical one.
  if (p.high === undefined || p.low === undefined) {
    const roomOnLeft = p.axis === 'h' ? p.high !== undefined : p.low !== undefined;
    return roomOnLeft ? { from: e, to: s } : { from: s, to: e };
  }
  return { from: s, to: e };
}

export const SIDE_VECTORS: Readonly<Record<Side, readonly [bigint, bigint]>> = { north: [0n, 1n], south: [0n, -1n], east: [1n, 0n], west: [-1n, 0n] };

/** The compass side a vector points to, for an axis-aligned vector. */
export function sideOfVector(dx: bigint, dy: bigint): Side {
  if (dx > 0n) return 'east';
  if (dx < 0n) return 'west';
  return dy > 0n ? 'north' : 'south';
}
