/**
 * The faces of one level of the working copy (Core §6.1), as selectors read them (3.4): which
 * bounded face a room's anchor is in, which faces lie either side of each edge, and the outward
 * normal of each edge on a face's outer cycle.
 *
 * Faces are defined only for a plane graph, so a level that breaks Core §5.1–5.3 has none to give
 * (FS-OPS-007). Mid-batch the working copy may be anything, so every member is checked before it is
 * read.
 */
import { HalfEdgeGraph, predicates, type Face } from '@floorspec/engine';
import { cmpStr, getMember, isObject, type JsonObject } from '../lib/json.js';
import type { WorkingCopy } from './working.js';

type IPoint = readonly [bigint, bigint];
const { collinearOverlap, eq, inSegmentInterior, onSegment, properCross } = predicates;

/** A JSON value that is a point of two safe integers, as BigInts. */
export function asPoint(v: unknown): IPoint | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [x, y] = v as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;
  return [BigInt(x), BigInt(y)];
}

export interface LevelEdgeRef {
  readonly id: string;
  readonly kind: 'walls' | 'separators';
  readonly start: string;
  readonly end: string;
}

/** Which elements a view of the working copy keeps: every one when undefined. */
export type Keep = ((e: JsonObject) => boolean) | undefined;

const FACE_COLLECTIONS = ['junctions', 'walls', 'separators', 'rooms'] as const;

/**
 * Ops 0.3, 2.8: the edit design's view, as a test of an element — `option` for its set when the
 * context names one, and every other set's primary. An element in any other option is left out, and
 * so is one whose option is not an option of the working copy. Undefined (keep everything) for a
 * working copy with no junction, edge or room in an option.
 */
export function editDesign(wc: WorkingCopy, option: string | undefined = wc.editOption): Keep {
  const any = FACE_COLLECTIONS.some((c) => wc.ids(c).some((id) => Object.hasOwn(wc.elementIn(c, id) ?? {}, 'option')));
  if (!any) return undefined;
  const opts = wc.collection('options') ?? {};
  const sets = wc.collection('optionSets') ?? {};
  const setOf = (o: string): unknown => getMember(opts[o], 'set');
  const theSet = option !== undefined && Object.hasOwn(opts, option) ? setOf(option) : undefined;
  const chosen = new Set<string>();
  for (const sid of Object.keys(sets)) {
    const primary = getMember(sets[sid], 'primary');
    if (typeof primary === 'string' && (option === undefined || sid !== theSet)) chosen.add(primary);
  }
  if (option !== undefined) chosen.add(option);
  for (const o of [...chosen]) if (!Object.hasOwn(opts, o)) chosen.delete(o);
  return (e) => !Object.hasOwn(e, 'option') || (typeof e.option === 'string' && chosen.has(e.option));
}

/** The edges (walls and separators) whose `level` is L, sorted by ID — those `keep` keeps. */
export function edgesOn(wc: WorkingCopy, level: string, keep?: Keep): LevelEdgeRef[] {
  const out: LevelEdgeRef[] = [];
  for (const kind of ['walls', 'separators'] as const)
    for (const id of wc.ids(kind)) {
      const e = wc.elementIn(kind, id);
      if (!e || getMember(e, 'level') !== level || (keep && !keep(e))) continue;
      const start = getMember(e, 'start');
      const end = getMember(e, 'end');
      out.push({ id, kind, start: typeof start === 'string' ? start : '', end: typeof end === 'string' ? end : '' });
    }
  return out.sort((a, b) => cmpStr(a.id, b.id));
}

/** The junctions whose `level` is L, with their positions when they are points — those `keep` keeps. */
export function junctionsOn(wc: WorkingCopy, level: string, keep?: Keep): { id: string; pos: IPoint | undefined }[] {
  const out: { id: string; pos: IPoint | undefined }[] = [];
  for (const id of wc.ids('junctions')) {
    const j = wc.elementIn('junctions', id);
    if (!j || getMember(j, 'level') !== level || (keep && !keep(j))) continue;
    out.push({ id, pos: asPoint(getMember(j, 'position')) });
  }
  return out;
}

export type RoomPlace = { kind: 'face'; face: number } | { kind: 'none'; why: string };

export class LevelFaces {
  readonly level: string;
  /** Why the level has no faces to give, or undefined when it has. */
  readonly broken: string | undefined;
  readonly graph: HalfEdgeGraph | undefined;
  readonly edges: readonly LevelEdgeRef[];
  readonly positions: ReadonlyMap<string, IPoint>;
  /** Cycle index → bounded face index, or −1 for the unbounded face. */
  private readonly faceOfCycle: number[] = [];
  /** The view of the working copy this level is read in (Ops 0.3, 2.8: the edit design). */
  readonly keep: Keep;

  constructor(wc: WorkingCopy, level: string, keep: Keep = editDesign(wc)) {
    this.level = level;
    this.keep = keep;
    this.edges = edgesOn(wc, level, keep);
    const positions = new Map<string, IPoint>();
    let broken: string | undefined;
    if (!wc.elementIn('levels', level)) broken = `there is no level ${level}`;
    for (const j of junctionsOn(wc, level, keep)) {
      if (!j.pos) broken ??= `junction ${j.id} has no position`;
      else positions.set(j.id, j.pos);
    }
    this.positions = positions;
    broken ??= this.planarityProblem();
    this.broken = broken;
    if (broken === undefined) {
      this.graph = new HalfEdgeGraph(positions, this.edges);
      const g = this.graph;
      g.cycles.forEach((c, i) => {
        const f = g.faces.findIndex((face) => face.outer === c || face.inner.includes(c));
        this.faceOfCycle[i] = f;
      });
    } else this.graph = undefined;
  }

  /** Core §5.1–5.3 on this level, and every edge's junctions on it: the conditions faces need. */
  private planarityProblem(): string | undefined {
    const P = this.positions;
    const seen = new Map<string, string>();
    for (const [id, p] of P) {
      const k = `${p[0]},${p[1]}`;
      const other = seen.get(k);
      if (other !== undefined) return `junctions ${other} and ${id} share a position (Core 5.1.1)`;
      seen.set(k, id);
    }
    const pairs = new Set<string>();
    for (const e of this.edges) {
      if (!P.has(e.start) || !P.has(e.end)) return `${e.id} does not run between two junctions of the level`;
      if (e.start === e.end) return `${e.id} starts and ends at one junction (Core 5.2.1)`;
      const k = e.start < e.end ? `${e.start}\u0000${e.end}` : `${e.end}\u0000${e.start}`;
      if (pairs.has(k)) return `two edges connect ${e.start} and ${e.end} (Core 5.2.2)`;
      pairs.add(k);
    }
    const segs = this.edges.map((e) => ({ id: e.id, a: P.get(e.start)!, b: P.get(e.end)! }));
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      for (const [jid, p] of P) if (inSegmentInterior(p, s.a, s.b)) return `junction ${jid} lies inside ${s.id} (Core 5.3.2)`;
      for (let j = i + 1; j < segs.length; j++) {
        const t = segs[j]!;
        if (properCross(s.a, s.b, t.a, t.b)) return `${s.id} and ${t.id} cross (Core 5.3.1)`;
        if (collinearOverlap(s.a, s.b, t.a, t.b)) return `${s.id} and ${t.id} overlap (Core 5.3.3)`;
      }
    }
    return undefined;
  }

  get faces(): readonly Face[] {
    return this.graph?.faces ?? [];
  }

  /** The face on the left of half-edge h (2e: edge e from start to end; 2e+1: back), or −1. */
  faceLeftOf(h: number): number {
    const g = this.graph!;
    return this.faceOfCycle[g.cycleOf[h]!] ?? -1;
  }

  edgeIndex(id: string): number {
    return this.edges.findIndex((e) => e.id === id);
  }

  /** Where a point is: in a bounded face, or not (on a location line, or in the unbounded face). */
  place(p: IPoint): RoomPlace {
    const g = this.graph;
    if (!g) return { kind: 'none', why: this.broken ?? 'no faces' };
    for (const e of this.edges) if (onSegment(p, this.positions.get(e.start)!, this.positions.get(e.end)!)) return { kind: 'none', why: `it lies on ${e.id}` };
    const f = g.innermostFace(p);
    return f ? { kind: 'face', face: g.faces.indexOf(f) } : { kind: 'none', why: 'it lies outside every enclosed face' };
  }

  /** Rooms on this level whose anchors are in face f, sorted. */
  roomsIn(wc: WorkingCopy, f: number): string[] {
    const out: string[] = [];
    for (const id of wc.ids('rooms')) {
      const r = wc.elementIn('rooms', id);
      if (!r || getMember(r, 'level') !== this.level || (this.keep && !this.keep(r))) continue;
      const a = asPoint(getMember(r, 'anchor'));
      if (!a) continue;
      const pl = this.place(a);
      if (pl.kind === 'face' && pl.face === f) out.push(id);
    }
    return out;
  }

  /** The outward normal (3.4) of a half-edge on an outer cycle: its right-hand normal. */
  outwardNormal(h: number): IPoint {
    const d = this.graph!.direction(h);
    return [d[1], -d[0]];
  }
}

/** The four sides of 3.4, as exact tests on an outward normal. */
export type Side = 'north' | 'south' | 'east' | 'west';
export const SIDES: readonly Side[] = ['north', 'south', 'east', 'west'];

export function sideOf(n: IPoint): Side {
  const [nx, ny] = n;
  if (nx > 0n && -nx < ny && ny <= nx) return 'east';
  if (ny > 0n && -ny <= nx && nx < ny) return 'north';
  if (nx < 0n && nx <= ny && ny < -nx) return 'west';
  return 'south';
}

/** The unit vector of a side (4.4). */
export const SIDE_UNIT: Readonly<Record<Side, IPoint>> = {
  east: [1n, 0n],
  north: [0n, 1n],
  west: [-1n, 0n],
  south: [0n, -1n],
};

/** Cache of LevelFaces per level, valid for one version of the working copy. */
export class FacesCache {
  private version = -1;
  private readonly cache = new Map<string, LevelFaces>();
  constructor(private readonly wc: WorkingCopy) {}
  get(level: string): LevelFaces {
    if (this.version !== this.wc.version) {
      this.cache.clear();
      this.version = this.wc.version;
    }
    let f = this.cache.get(level);
    if (!f) {
      f = new LevelFaces(this.wc, level);
      this.cache.set(level, f);
    }
    return f;
  }
}

export { eq as pointsEqual, isObject };
