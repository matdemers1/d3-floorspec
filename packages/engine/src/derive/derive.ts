/**
 * The deriver (chapters 5–7, 11–14): every value a conformant deriver derives from a valid
 * document, in the conformance suite's `derived` format (conformance/README.md).
 */
import { Surd } from '../exact/surd.js';
import { toSafeNumber } from '../exact/bigint.js';
import { roundPoint, toNumbers } from '../geometry/exact-point.js';
import type { IPoint } from '../geometry/predicates.js';
import { deriveFloors, roomRings, type DerivedCeiling, type DerivedFloor, type DerivedSlab } from '../slabs/floors.js';
import { effectiveClearOpening, entries, extElements, get, ipoint, openingDimensions, wallElevations, type ClearOpening, type FloorspecDocument } from '../model/document.js';
import type { Analysis } from '../validate/invariants.js';
import { elementFrame, envelopesOverlap, footprintOf, openingFrame, placementOf, type Footprint, type Placement } from './frames.js';
import { comparePoints } from './level.js';
import { analyseProgram, type DerivedProgram } from './program.js';
import { analyseCirculation, type DerivedCirculationRoom } from '../circulation/circulation.js';
import type { DerivedExtensions } from '../extensions/official.js';
import { deriveRoofs, type DerivedRoof } from '../roofs/roofs.js';
import { deriveStairs, StairContext, type DerivedStair } from '../stairs/stairs.js';
import { deriveFinishes, type DerivedFinishes } from '../finishes/finishes.js';
import type { DerivedOptionSet } from '../options/options.js';

export type { DerivedRoof, DerivedRoofFace, DerivedRoofLine } from '../roofs/roofs.js';
export type { DerivedStair } from '../stairs/stairs.js';

export type { DerivedProgram, DerivedProgramItem, DerivedAdjacency } from './program.js';
export type { DerivedCirculationRoom } from '../circulation/circulation.js';
export type { Placement as DerivedPlacement } from './frames.js';

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
  /**
   * 7.4 (Core 0.3): the opening's effective clear opening, exactly as declared — present only when
   * one resolves, and with an `area` only when one is declared. Never computed.
   */
  clearOpening?: { width: number; height: number; area?: number };
}

/** 12.6: an extension element's fallback box, in its frame. */
export interface DerivedFallback extends Footprint {
  level: string;
  extension: string;
  collection: string;
}

/** 13.5: a clearance envelope, in its owner's frame. */
export interface DerivedClearance extends Footprint {
  level: string;
  purpose: 'workingSpace' | 'fixtureClearance' | 'swing' | 'access';
}

/** 13.6: one envelope of an overlapping pair — its owner (an opening or an extension element) and its name. */
export type EnvelopeRef = [owner: string, name: string];

export interface Derived {
  /**
   * What each official extension the reader implements and evaluated derives (each extension's
   * spec): present, possibly empty, whenever the reader implements one.
   */
  extensions?: DerivedExtensions;
  walls: Record<string, DerivedWall>;
  junctionFills: Record<string, Point[]>;
  rooms: Record<string, DerivedRoomPolygon>;
  unanchored: DerivedUnanchored[];
  openings: Record<string, DerivedOpening>;
  // Core 0.2 — present whenever the reader implements 0.2, even for a 0.1 document (empty then).
  /** 11.3, 11.4: each item's rooms and whether they meet it; each adjacency, in document order. */
  program?: DerivedProgram;
  /** 12.6: every extension element's fallback box. */
  fallbacks?: Record<string, DerivedFallback>;
  /** 13.4: every hosted extension element's placement. */
  placements?: Record<string, Placement>;
  /** 13.5: every clearance envelope, by owner and name. */
  clearances?: Record<string, Record<string, DerivedClearance>>;
  /** 13.6: every pair of envelopes of different owners that overlap, each pair sorted, the list sorted. */
  clearanceOverlaps?: [EnvelopeRef, EnvelopeRef][];
  /** 14.3: every room — whether it is an entry, whether it is reachable, and for a sleeping room whether only through another. */
  circulation?: Record<string, DerivedCirculationRoom>;
  // Core 0.3 — present whenever the reader implements 0.3, for a document of any draft.
  /** 15.1: every room's floor: its top, bottom and box. */
  floors?: Record<string, DerivedFloor>;
  /** 15.5: every room's ceiling: its kind, low, high, box and a tray's centre. */
  ceilings?: Record<string, DerivedCeiling>;
  /** 15.7: every slab's outline, top, bottom and box. */
  slabs?: Record<string, DerivedSlab>;
  /** 16.5: every roof's kind, eave outline, eave and surface (null when this draft does not derive it). */
  roofs?: Record<string, DerivedRoof>;
  /** 17.4–17.6: every stair's risers, rise, foot and head, box, and for a straight, L or U stair its steps, run, walkline and headroom. */
  stairs?: Record<string, DerivedStair>;
  /** 18.6: every room's floor and ceiling finish, and every finished side of every wall. */
  finishes?: DerivedFinishes;
  /** 19.6.3: for a document with design options, every set's chosen option and every option's members, rooms and affected elements. */
  options?: Record<string, DerivedOptionSet>;
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
      ...clearOpeningOf(effectiveClearOpening(doc, o)),
    });
  }
  if (analysis.core02) Object.assign(out, derive02(doc, analysis));
  // Core 0.3 (chapters 15–17): every room's floor and ceiling, every slab, roof and stair, for a document of any draft.
  if (analysis.core03)
    Object.assign(
      out,
      deriveFloors(doc, (id, room) => {
        const la = analysis.levels.get(room.level)!;
        return roomRings(la.geometry!, la.roomFaces.get(id)!);
      }),
      { roofs: deriveRoofs(doc, analysis.core04 ?? false), stairs: deriveStairs(new StairContext(doc, analysis.levels), analysis.core04 ?? false), finishes: deriveFinishes(doc, analysis.levels) },
    );
  return out;
}

/** 7.4.2: a derived clear opening has exactly the members declared. */
const clearOpeningOf = (c: ClearOpening | undefined): Pick<DerivedOpening, 'clearOpening'> =>
  c ? { clearOpening: { width: c.width, height: c.height, ...(c.area !== undefined && { area: c.area }) } } : {};

const cmpRef = (a: EnvelopeRef, b: EnvelopeRef): number =>
  a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0;

/** The members Core 0.2 adds: the program (11.3, 11.4), fallbacks (12.6), placements (13.4), clearances (13.5, 13.6), circulation (14.3). */
function derive02(doc: FloorspecDocument, analysis: Analysis): Required<Pick<Derived, 'program' | 'fallbacks' | 'placements' | 'clearances' | 'clearanceOverlaps' | 'circulation'>> {
  const fallbacks: Record<string, DerivedFallback> = {};
  const placements: Record<string, Placement> = {};
  const clearances: Record<string, Record<string, DerivedClearance>> = {};
  const envelopes: { ref: EnvelopeRef; fp: DerivedClearance }[] = [];
  const envelope = (owner: string, name: string, v: DerivedClearance): void => {
    if (!Object.hasOwn(clearances, owner)) setMember(clearances, owner, {});
    setMember(clearances[owner]!, name, v);
    envelopes.push({ ref: [owner, name], fp: v });
  };

  for (const [oid, o] of entries(doc.openings)) {
    const t = o.fill === undefined ? undefined : get(doc.types, o.fill);
    const cl = t && t.kind !== 'wallType' ? entries(t.clearances) : [];
    if (!cl.length) continue;
    const frame = openingFrame(doc, oid);
    const level = get(doc.walls, o.wall)!.level;
    for (const [name, env] of cl) envelope(oid, name, { purpose: env.purpose, level, ...footprintOf(frame, env) });
  }
  for (const x of extElements(doc)) {
    const frame = elementFrame(doc, analysis, x.element);
    const fb = x.element.fallback;
    setMember(fallbacks, x.id, { extension: x.extension, collection: x.collection, level: fb.level, ...footprintOf(frame, fb.box) });
    if (x.element.host) setMember(placements, x.id, placementOf(frame));
    for (const [name, env] of entries(x.element.clearances)) envelope(x.id, name, { purpose: env.purpose, level: fb.level, ...footprintOf(frame, env) });
  }
  const overlaps: [EnvelopeRef, EnvelopeRef][] = [];
  for (let i = 0; i < envelopes.length; i++)
    for (let k = i + 1; k < envelopes.length; k++) {
      const a = envelopes[i]!;
      const b = envelopes[k]!;
      if (a.ref[0] !== b.ref[0] && envelopesOverlap(a.fp, b.fp)) overlaps.push(cmpRef(a.ref, b.ref) <= 0 ? [a.ref, b.ref] : [b.ref, a.ref]);
    }
  overlaps.sort((p, q) => cmpRef(p[0], q[0]) || cmpRef(p[1], q[1]));
  return {
    program: analyseProgram(doc, analysis).derived,
    fallbacks,
    placements,
    clearances,
    clearanceOverlaps: overlaps,
    circulation: analyseCirculation(doc, analysis).derived,
  };
}
