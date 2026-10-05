/**
 * Chapter 8: the wall line of a room (8.1), receptacle reach and the wall run between receptacles
 * (8.2), circuits (8.3) and levels (8.4: `roomCount` here; `elementCount` of a level is rooms.ts's
 * one measure for both kinds).
 *
 * Every length on the wall line is an integer rounded once where 8.1 says; half-gaps are kept
 * doubled until the one final rounding.
 */
import { elementDefaults, matches, own, recordDefaults, sortIds, type IPoint, type Model } from '../model.js';
import { roundDivSqrt, roundSqrt } from '../exact.js';
import { aCollection, aFunction, aLength, aMatch, measure, type Args, type Measure } from './measure.js';

const ELEC = 'FS_electrical';

export interface WallLine {
  /** Its total length. */
  readonly total: bigint;
  /** Its breaks, as intervals of positions along it. */
  readonly breaks: readonly (readonly [bigint, bigint])[];
  /** The receptacles on it: [position along it, ID]. */
  readonly receptacles: readonly (readonly [bigint, string])[];
}

const absB = (a: bigint): bigint => (a < 0n ? -a : a);
const maxB = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));

/** 8.1: the wall line of a room, with positions measured from the start of the first run of its walk. */
export function wallLine(m: Model, rid: string): WallLine {
  const key = `wallLine:${rid}`;
  const hit = m.memo.get(key) as WallLine | undefined;
  if (hit) return hit;
  const lv = m.level(m.room(rid).level);
  const g = lv.g;
  const walk = g.faces[lv.roomFace.get(rid)!]!.outer.halfEdges;
  const n = walk.length;
  // The points the ring takes at each half-edge's head junction: wedge m − 1 reversed (Core 6.2).
  const contrib: IPoint[][] = walk.map((h) => {
    const v = g.graph.dest(h);
    const k = g.graph.stars.get(v)!.length;
    const idx = g.graph.starIndex[h ^ 1]!;
    return [...g.corners.get(v)![(idx - 1 + k) % k]!].reverse().map((p) => g.round(p));
  });
  // Doorways (Core 11.4): openings with no fill or a door, by wall, as [offset, offset + width].
  const doors = new Map<string, [bigint, bigint][]>();
  for (const oid of Object.keys(m.doc.openings ?? {})) {
    const o = m.opening(oid);
    if (o.fill !== undefined && own(m.doc.types, o.fill)?.kind !== 'doorType') continue;
    const a = BigInt(o.offset);
    doors.set(o.wall, [...(doors.get(o.wall) ?? []), [a, a + m.openingDims(oid).width]]);
  }
  const recs: { id: string; wall: string; side: string; offset: bigint }[] = [];
  for (const [eid, x] of m.ext) {
    const h = x.element.host;
    if (x.extension === ELEC && x.collection === 'receptacles' && h?.mode === 'wallFace') recs.push({ id: eid, wall: h.wall, side: h.side, offset: BigInt(h.offset) });
  }
  let pos = 0n;
  const breaks: [bigint, bigint][] = [];
  const found: [bigint, string][] = [];
  for (let i = 0; i < n; i++) {
    const h = walk[i]!;
    const e = g.edges[h >> 1]!;
    const forward = (h & 1) === 0;
    const p1 = contrib[(i - 1 + n) % n]!.at(-1)!;
    const p2 = contrib[i]![0]!;
    const S = g.junctions.get(e.start)!.pos;
    const E = g.junctions.get(e.end)!.pos;
    const d: IPoint = [E[0] - S[0], E[1] - S[1]];
    const D = d[0] * d[0] + d[1] * d[1];
    const s1 = roundDivSqrt((p1[0] - S[0]) * d[0] + (p1[1] - S[1]) * d[1], D);
    const s2 = roundDivSqrt((p2[0] - S[0]) * d[0] + (p2[1] - S[1]) * d[1], D);
    const raw = forward ? s2 - s1 : s1 - s2;
    const length = raw > 0n ? raw : 0n;
    const [lo, hi] = forward ? [s1, s2] : [s2, s1];
    if (lo <= hi) {
      // A run of length 0 has no break, but may hold a receptacle.
      const along = (s: bigint): bigint => pos + absB(s - s1);
      if (e.kind === 'separator') {
        if (length > 0n) breaks.push([pos, pos + length]);
      } else {
        for (const [a0, b0] of doors.get(e.id) ?? []) {
          const a = a0 > lo ? a0 : lo;
          const b = b0 < hi ? b0 : hi;
          if (b > a) {
            const x = along(a);
            const y = along(b);
            breaks.push(x <= y ? [x, y] : [y, x]);
          }
        }
        const side = forward ? 'left' : 'right';
        for (const r of recs) if (r.wall === e.id && r.side === side && lo <= r.offset && r.offset <= hi) found.push([along(r.offset), r.id]);
      }
    }
    pos += length;
    const c = contrib[i]!;
    if (c.length === 2) {
      // A return at the head junction.
      const [q1, q2] = c as [IPoint, IPoint];
      pos += roundSqrt((q2[0] - q1[0]) ** 2n + (q2[1] - q1[1]) ** 2n);
    }
  }
  const out = { total: pos, breaks, receptacles: found };
  m.memo.set(key, out);
  return out;
}

/** 8.1: the stretches of a wall line, as [start, end, closed]; an end may pass `total` for a stretch that wraps past the start. */
export function stretches(total: bigint, breaks: readonly (readonly [bigint, bigint])[]): [bigint, bigint, boolean][] {
  if (total <= 0n) return [];
  if (breaks.length === 0) return [[0n, total, true]];
  const bs = [...breaks].sort((p, q) => (p[0] !== q[0] ? (p[0] < q[0] ? -1 : 1) : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
  const merged: [bigint, bigint][] = [[bs[0]![0], bs[0]![1]]];
  for (const [a, b] of bs.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (a <= last[1]) last[1] = b > last[1] ? b : last[1];
    else merged.push([a, b]);
  }
  const out: [bigint, bigint, boolean][] = [];
  merged.forEach(([, b], i) => {
    const next = merged[(i + 1) % merged.length]![0] + (i === merged.length - 1 ? total : 0n);
    if (next > b) out.push([b, next, false]);
  });
  return out;
}

/** 8.2: receptacle reach and the wall run between receptacles, for the counted receptacles. */
export function receptacleMeasures(m: Model, rid: string, counted: (eid: string) => boolean): { reach: bigint; run: bigint; ids: string[] } {
  const { total, breaks, receptacles } = wallLine(m, rid);
  const pts = receptacles.filter(([, r]) => counted(r));
  const ids = sortIds(new Set(pts.map(([, r]) => r)));
  let reach2 = 0n; // reach doubled, to keep halves exact
  let run = 0n;
  const uniqSorted = (xs: bigint[]): bigint[] => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [a, b, closed] of stretches(total, breaks)) {
    const ell = b - a;
    const rs = closed ? uniqSorted(pts.map(([p]) => p % total)) : uniqSorted(pts.flatMap(([p]) => [p, p + total]).filter((x) => a <= x && x <= b).map((x) => x - a));
    if (rs.length === 0) {
      reach2 = maxB(reach2, 2n * ell);
      run = maxB(run, ell);
      continue;
    }
    const gaps = rs.slice(1).map((r, i) => r - rs[i]!);
    if (closed) {
      gaps.push(rs[0]! + ell - rs[rs.length - 1]!);
      reach2 = maxB(reach2, ...gaps);
      run = maxB(run, ...gaps);
    } else {
      reach2 = maxB(reach2, 2n * rs[0]!, 2n * (ell - rs[rs.length - 1]!), ...gaps);
      run = maxB(run, rs[0]!, ell - rs[rs.length - 1]!, ...gaps);
    }
  }
  const half = reach2 / 2n;
  const reach = reach2 % 2n === 0n || half % 2n === 0n ? half : half + 1n; // the one rounding, ties to even
  return { reach, run, ids };
}

/** 8.2: the counted receptacles — matching `match`, and placed at most `maxHeight` above the floor. */
function counted(m: Model, rid: string, a: Args): (eid: string) => boolean {
  const floor = m.floor(m.room(rid).level);
  const defaults = elementDefaults(ELEC, 'receptacles');
  return (eid) => {
    const x = m.ext.get(eid)!;
    if (a.match !== undefined && !matches(x.element, defaults, a.match as Record<string, unknown>)) return false;
    return a.maxHeight === undefined || BigInt(own(m.derived.placements, eid)!.point[2]) - floor <= BigInt(a.maxHeight as number);
  };
}

const RECEPTACLE_ARGS = { match: aMatch, maxHeight: aLength };
const readsWithMatch = (a: Args): string[] => (a.match !== undefined ? [ELEC] : []);

export const WALL_LINE_MEASURES: readonly Measure[] = [
  measure({
    name: 'receptacleReach',
    kinds: ['room'],
    type: 'length',
    args: RECEPTACLE_ARGS,
    involved: true,
    reads: readsWithMatch,
    compute: (m, t, a) => {
      const r = receptacleMeasures(m, t.id, counted(m, t.id, a));
      return { value: r.reach, involved: r.ids };
    },
  }),
  measure({
    name: 'wallRunBetweenReceptacles',
    kinds: ['room'],
    type: 'length',
    args: RECEPTACLE_ARGS,
    involved: true,
    reads: readsWithMatch,
    compute: (m, t, a) => {
      const r = receptacleMeasures(m, t.id, counted(m, t.id, a));
      return { value: r.run, involved: r.ids };
    },
  }),
  measure({
    name: 'circuitCount',
    kinds: ['room'],
    type: 'count',
    args: { collection: aCollection, match: aMatch, circuit: aMatch },
    involved: true,
    reads: () => [ELEC],
    compute: (m, t, a) => {
      const coll = (a.collection as string | undefined) ?? 'receptacles';
      const edef = elementDefaults(ELEC, coll);
      const cdef = recordDefaults(ELEC, 'circuits');
      const out: string[] = [];
      for (const [cid, c] of m.circuits()) {
        if (a.circuit !== undefined && !matches(c, cdef, a.circuit as Record<string, unknown>)) continue;
        const loads = Object.hasOwn(c, 'loads') ? c.loads : [];
        if (!Array.isArray(loads)) continue;
        const hit = loads.some((load) => {
          if (typeof load !== 'string') return false;
          const x = m.ext.get(load);
          return (
            x !== undefined &&
            x.extension === ELEC &&
            x.collection === coll &&
            m.roomOf(load) === t.id &&
            (a.match === undefined || matches(x.element, edef, a.match as Record<string, unknown>))
          );
        });
        if (hit) out.push(cid);
      }
      return { value: BigInt(out.length), involved: out };
    },
  }),
  measure({
    name: 'roomCount',
    kinds: ['level'],
    type: 'count',
    args: { function: aFunction },
    compute: (m, t, a) => {
      let n = 0n;
      for (const rid of Object.keys(m.doc.rooms ?? {})) if (m.room(rid).level === t.id && (a.function === undefined || m.roomFunction(rid) === a.function)) n++;
      return { value: n };
    },
  }),
];
