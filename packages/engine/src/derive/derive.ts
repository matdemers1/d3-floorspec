/**
 * The deriver (chapters 5–7): every value a conformant deriver derives from a valid document, in the
 * conformance suite's `derived` format (conformance/README.md).
 */
import { Surd } from '../exact/surd.js';
import { toSafeNumber } from '../exact/bigint.js';
import { roundPoint, toNumbers } from '../geometry/exact-point.js';
import type { IPoint } from '../geometry/predicates.js';
import { entries, get, ipoint, openingDimensions, wallElevations, type FloorspecDocument } from '../model/document.js';
import type { Analysis } from '../validate/invariants.js';
import { comparePoints } from './level.js';

export type Point = [number, number];

export interface DerivedWall {
  startRight: Point;
  endRight: Point;
  endLeft: Point;
  startLeft: Point;
  baseElevation: number;
  topElevation: number;
}

export interface DerivedRoomPolygon {
  outer: Point[];
  holes: Point[][];
  /** Net area in square base units, as a decimal string: an integer, or an integer and `.5`. */
  area: string;
}

export interface DerivedUnanchored extends DerivedRoomPolygon {
  level: string;
}

export interface DerivedOpening {
  start: Point;
  end: Point;
  sillElevation: number;
  headElevation: number;
}

export interface Derived {
  walls: Record<string, DerivedWall>;
  junctionFills: Record<string, Point[]>;
  rooms: Record<string, DerivedRoomPolygon>;
  unanchored: DerivedUnanchored[];
  openings: Record<string, DerivedOpening>;
}

/** Half of a BigInt, as a decimal string (6.4: a net area is a multiple of one half). */
export function halfString(twice: bigint): string {
  const neg = twice < 0n;
  const a = neg ? -twice : twice;
  const s = `${a / 2n}${a % 2n === 1n ? '.5' : ''}`;
  return neg ? `-${s}` : s;
}

const ring = (pts: readonly IPoint[]): Point[] => pts.map(toNumbers);

const setMember = <T>(obj: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
};

/** Derive everything from a valid document and the validator's analysis of it. */
export function deriveFrom(doc: FloorspecDocument, analysis: Analysis): Derived {
  const out: Derived = { walls: {}, junctionFills: {}, rooms: {}, unanchored: [], openings: {} };

  for (const [id, w] of entries(doc.walls)) {
    const g = analysis.levels.get(w.level)!.geometry!;
    const fe = g.roundedFaceEnds(id);
    const el = wallElevations(doc, w)!;
    setMember(out.walls, id, {
      startRight: toNumbers(fe.startRight),
      endRight: toNumbers(fe.endRight),
      endLeft: toNumbers(fe.endLeft),
      startLeft: toNumbers(fe.startLeft),
      baseElevation: toSafeNumber(el.base),
      topElevation: toSafeNumber(el.top),
    });
  }

  for (const [id, j] of entries(doc.junctions)) {
    const g = analysis.levels.get(j.level)!.geometry!;
    const f = g.fill(id);
    if (f && !f.empty) setMember(out.junctionFills, id, ring(f.ring));
  }

  for (const [lid, la] of [...analysis.levels].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const g = la.geometry!;
    const anchored = new Set(la.roomFaces.values());
    for (const [rid, face] of [...la.roomFaces].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const p = g.roomPolygon(g.faces[face]!);
      setMember(out.rooms, rid, { outer: ring(p.outer), holes: p.holes.map(ring), area: halfString(p.area2) });
    }
    const free = g.faces
      .map((f, i) => ({ i, p: g.roomPolygon(f) }))
      .filter(({ i, p }) => !anchored.has(i) && !p.degenerate)
      .sort((a, b) => comparePoints(a.p.outer[0]!, b.p.outer[0]!));
    for (const { p } of free) out.unanchored.push({ level: lid, outer: ring(p.outer), holes: p.holes.map(ring), area: halfString(p.area2) });
  }

  for (const [id, o] of entries(doc.openings)) {
    const w = get(doc.walls, o.wall)!;
    const S = ipoint(get(doc.junctions, w.start)!.position);
    const E = ipoint(get(doc.junctions, w.end)!.position);
    const d: IPoint = [E[0] - S[0], E[1] - S[1]];
    const m = d[0] * d[0] + d[1] * d[1];
    const dim = openingDimensions(doc, o);
    // S + d · t / |d| = S + d · t · √m / m (7.4)
    const at = (t: bigint): Point => {
      const k = Surd.sqrt(m).mulInt(t).divInt(m);
      return toNumbers(roundPoint({ x: k.mulInt(d[0]).addInt(S[0]), y: k.mulInt(d[1]).addInt(S[1]) }));
    };
    const el = wallElevations(doc, w)!;
    const sill = el.base + BigInt(dim.sill);
    setMember(out.openings, id, {
      start: at(BigInt(o.offset)),
      end: at(BigInt(o.offset) + BigInt(dim.width!)),
      sillElevation: toSafeNumber(sill),
      headElevation: toSafeNumber(sill + BigInt(dim.height!)),
    });
  }
  return out;
}
