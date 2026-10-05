/**
 * What the measures read from one valid document (Rules 4): the engine's evaluation and derived
 * values, each level's faces, the room of every extension element (4.4), extension members read
 * with their defaults (4.5), the frames of openings and extension elements (Core 13.1), and which
 * official extensions are evaluated for the document (1.2).
 *
 * Built only from a document the engine found valid, so every lookup here resolves.
 */
import {
  extElements,
  facingVector,
  Surd,
  type Derived,
  type DerivedClearance,
  type Evaluation,
  type ExtElement,
  type ExtensionElement,
  type FloorspecDocument,
  type Host,
  type LevelGeometry,
  type Opening,
  type Room,
} from '@floorspec/engine';
import { ELEMENT_DEFAULTS, RECORD_DEFAULTS } from './generated/extension-defaults.js';
import type { Units } from './types.js';

export type Analysis = NonNullable<Evaluation['analysis']>;
export type IPoint = readonly [bigint, bigint];
type Json = Record<string, unknown>;

/** The value of an own member, or undefined — never an inherited one (an ID may be `constructor`). */
export function own<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
  return rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Compare strings as sequences of UTF-16 code units (Rules 9.7, Core 9.2). */
export const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const sortIds = (ids: Iterable<string>): string[] => [...ids].sort(cmpStr);

/** 4.5: a member read with its default — [present, value]. */
export function member(obj: Json, defaults: Readonly<Record<string, unknown>>, name: string): [boolean, unknown] {
  if (Object.hasOwn(obj, name)) return [true, obj[name]];
  if (Object.hasOwn(defaults, name)) return [true, defaults[name]];
  return [false, undefined];
}

/** Is a JSON value equal to a match value (a string, an integer or a boolean)? */
const same = (x: unknown, want: unknown): boolean => typeof x === typeof want && x === want;

/** 4.5: does an element or record match `match`, every member read with its default? */
export function matches(obj: Json, defaults: Readonly<Record<string, unknown>>, match: Readonly<Record<string, unknown>>): boolean {
  for (const [k, want] of Object.entries(match)) {
    const [present, v] = member(obj, defaults, k);
    if (!present) return false;
    if (Array.isArray(v)) {
      if (!v.some((x) => same(x, want))) return false;
    } else if (!same(v, want)) return false;
  }
  return true;
}

/** 4.5: the defaults an official extension's specification gives an element's members. */
export const elementDefaults = (extension: string, collection: string): Readonly<Record<string, unknown>> =>
  own(own(ELEMENT_DEFAULTS, extension), collection) ?? {};

/** 4.5: the defaults an official extension's specification gives a record's members (`circuits`, …). */
export const recordDefaults = (extension: string, records: string): Readonly<Record<string, unknown>> =>
  own(own(RECORD_DEFAULTS, extension), records) ?? {};

/** A frame's plan part (Core 13.1): its exact origin and its integer facing vector. */
export interface PlanFrame {
  readonly ox: Surd;
  readonly oy: Surd;
  readonly f: IPoint;
}

export interface Box {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly purpose?: string;
}

/** One level's faces: the face of each half-edge (undefined on the unbounded face) and the room anchored in each face. */
export class LevelFaces {
  readonly g: LevelGeometry;
  readonly edgeIndex: ReadonlyMap<string, number>;
  readonly roomFace: ReadonlyMap<string, number>;
  readonly faceRoom: ReadonlyMap<number, string>;
  private readonly faceOfCycle = new Map<number, number>();

  constructor(g: LevelGeometry, roomFaces: ReadonlyMap<string, number>) {
    this.g = g;
    this.edgeIndex = new Map(g.edges.map((e, i) => [e.id, i]));
    const cycleIndex = new Map(g.graph.cycles.map((c, i) => [c, i]));
    g.faces.forEach((f, i) => {
      for (const c of [f.outer, ...f.inner]) this.faceOfCycle.set(cycleIndex.get(c)!, i);
    });
    this.roomFace = roomFaces;
    this.faceRoom = new Map([...roomFaces].map(([r, f]) => [f, r]));
  }

  /** The bounded face a half-edge lies on, or undefined for the unbounded face. */
  faceOf(h: number): number | undefined {
    return this.faceOfCycle.get(this.g.graph.cycleOf[h]!);
  }

  /** The two half-edges of an edge: start → end, then end → start. */
  halfEdges(edgeId: string): [number, number] {
    const i = this.edgeIndex.get(edgeId)!;
    return [2 * i, 2 * i + 1];
  }
}

/** Everything the measures read from one valid document. */
export class Model {
  readonly doc: FloorspecDocument;
  readonly analysis: Analysis;
  readonly derived: Derived;
  /** The official extensions evaluated for the document (1.2). */
  readonly evaluated: ReadonlySet<string>;
  readonly units: Units;
  /** Every extension element, by ID. */
  readonly ext: ReadonlyMap<string, ExtElement>;
  private readonly levels = new Map<string, LevelFaces>();
  private roomCache?: Map<string, string | undefined>;
  /** A per-model memo the measures share (room relations, wall lines, …). */
  readonly memo = new Map<string, unknown>();

  constructor(doc: FloorspecDocument, analysis: Analysis, derived: Derived, evaluated: Iterable<string>, units: Units) {
    this.doc = doc;
    this.analysis = analysis;
    this.derived = derived;
    this.evaluated = new Set(evaluated);
    this.units = units;
    const ext = new Map<string, ExtElement>();
    for (const x of extElements(doc)) ext.set(x.id, x);
    this.ext = ext;
  }

  level(lid: string): LevelFaces {
    let l = this.levels.get(lid);
    if (!l) {
      const la = this.analysis.levels.get(lid)!;
      l = new LevelFaces(la.geometry!, la.roomFaces);
      this.levels.set(lid, l);
    }
    return l;
  }

  /** The floor of a level: its elevation (4.1). */
  floor(lid: string): bigint {
    return BigInt(own(this.doc.levels, lid)!.elevation);
  }

  room(rid: string): Room {
    return own(this.doc.rooms, rid)!;
  }

  /** 5.1: a room's function, with its default. */
  roomFunction(rid: string): string {
    return this.room(rid).function ?? 'unspecified';
  }

  opening(oid: string): Opening {
    return own(this.doc.openings, oid)!;
  }

  wallLevel(wid: string): string {
    return own(this.doc.walls, wid)!.level;
  }

  /** Core 7.2: an opening's effective width, height and sill. */
  openingDims(oid: string): { width: bigint; height: bigint; sill: bigint } {
    const o = this.opening(oid);
    const t = o.fill === undefined ? undefined : own(this.doc.types, o.fill);
    const fill = t && t.kind !== 'wallType' ? t : undefined;
    return { width: BigInt(o.width ?? fill?.width ?? 0), height: BigInt(o.height ?? fill?.height ?? 0), sill: BigInt(o.sill ?? fill?.sill ?? 0) };
  }

  /** The FS_electrical circuits (FS_electrical 3.1), sorted by ID. */
  circuits(): [string, Json][] {
    const data = own(this.doc.extensions as Json | undefined, 'FS_electrical');
    const cs = isObject(data) ? data.circuits : undefined;
    if (!isObject(cs)) return [];
    return sortIds(Object.keys(cs)).flatMap((k) => (isObject(cs[k]) ? [[k, cs[k]] as [string, Json]] : []));
  }

  // ── 4.1 targets ──────────────────────────────────────────────────────────────

  /** The level of a target (4.1). */
  targetLevel(t: { kind: string; id: string; envelope?: string }): string {
    switch (t.kind) {
      case 'room':
        return this.room(t.id).level;
      case 'opening':
        return this.wallLevel(this.opening(t.id).wall);
      case 'element':
        return this.ext.get(t.id)!.element.fallback.level;
      case 'envelope':
        return this.clearance(t.id, t.envelope!).level;
      default:
        return t.id;
    }
  }

  // ── 4.4 the room of an element ───────────────────────────────────────────────

  /** 4.4: the room an extension element is in, as the official extensions decide it (FS_electrical 6.1). */
  roomOf(eid: string): string | undefined {
    if (!this.roomCache) {
      const out = new Map<string, string | undefined>();
      for (const [id, x] of this.ext) out.set(id, this.hostRoom(x.element.host));
      this.roomCache = out;
    }
    return this.roomCache.get(eid);
  }

  private hostRoom(host: Host | undefined): string | undefined {
    if (host === undefined) return undefined;
    if (host.mode === 'surface') return host.room;
    if (host.mode === 'wallFace') {
      const lv = this.level(this.wallLevel(host.wall));
      const [left, right] = lv.halfEdges(host.wall);
      const face = lv.faceOf(host.side === 'left' ? left : right);
      return face === undefined ? undefined : lv.faceRoom.get(face);
    }
    const lv = this.level(host.level);
    const where = lv.g.locateAnchor([BigInt(host.position[0]), BigInt(host.position[1])]);
    return where.kind === 'face' ? lv.faceRoom.get(where.face) : undefined;
  }

  // ── Core 13: frames and clearance envelopes ──────────────────────────────────

  clearance(owner: string, name: string): DerivedClearance {
    return own(own(this.derived.clearances, owner), name)!;
  }

  /** The names of an owner's clearance envelopes, sorted. */
  envelopesOf(owner: string): string[] {
    return sortIds(Object.keys(own(this.derived.clearances, owner) ?? {}));
  }

  /** The box of a clearance envelope as its owner declares it. */
  envelopeBox(owner: string, name: string): Box {
    if (own(this.doc.openings, owner) !== undefined) {
      const t = own(this.doc.types, this.opening(owner).fill!)!;
      return own((t as { clearances?: Record<string, Box> }).clearances, name)!;
    }
    return own(this.ext.get(owner)!.element.clearances as Record<string, Box> | undefined, name)!;
  }

  /** The wall that hosts an owner: an opening's wall, or a wallFace host's; otherwise none. */
  hostWall(owner: string): string | undefined {
    const o = own(this.doc.openings, owner);
    if (o !== undefined) return o.wall;
    const host = this.ext.get(owner)?.element.host;
    return host?.mode === 'wallFace' ? host.wall : undefined;
  }

  /** Core 13.1: the plan frame of an envelope's owner. */
  frameOf(owner: string): PlanFrame {
    if (own(this.doc.openings, owner) !== undefined) return this.openingFrame(owner);
    return this.elementFrame(this.ext.get(owner)!.element);
  }

  private wallLine(wid: string): { S: IPoint; d: IPoint; D: bigint } {
    const w = own(this.doc.walls, wid)!;
    const s = own(this.doc.junctions, w.start)!.position;
    const e = own(this.doc.junctions, w.end)!.position;
    const S: IPoint = [BigInt(s[0]), BigInt(s[1])];
    const d: IPoint = [BigInt(e[0]) - S[0], BigInt(e[1]) - S[1]];
    return { S, d, D: d[0] * d[0] + d[1] * d[1] };
  }

  /** S + (along2·t + normal2·n) / 2, with t and n the unit vectors along the wall and to its left. */
  private wallPoint(wid: string, along2: bigint, normal2: bigint): { x: Surd; y: Surd } {
    const l = this.wallLine(wid);
    const k = Surd.sqrt(l.D);
    const [dx, dy] = l.d;
    return {
      x: k.mulInt(along2 * dx - normal2 * dy).divInt(2n * l.D).addInt(l.S[0]),
      y: k.mulInt(along2 * dy + normal2 * dx).divInt(2n * l.D).addInt(l.S[1]),
    };
  }

  /** Core 13.1: an opening's frame — on the location line at its middle, facing the side it swings to. */
  private openingFrame(oid: string): PlanFrame {
    const o = this.opening(oid);
    const dim = this.openingDims(oid);
    const p = this.wallPoint(o.wall, 2n * BigInt(o.offset) + dim.width, 0n);
    const [dx, dy] = this.wallLine(o.wall).d;
    return { ox: p.x, oy: p.y, f: (o.swing ?? 'right') === 'left' ? [-dy, dx] : [dy, -dx] };
  }

  /** Core 12.6, 13.1: an extension element's frame — its host's, or its fallback level's. */
  private elementFrame(el: ExtensionElement): PlanFrame {
    const host = el.host;
    if (host === undefined) return { ox: Surd.ZERO, oy: Surd.ZERO, f: [1n, 0n] };
    if (host.mode === 'wallFace') {
      const off = this.analysis.offsets.get(host.wall)!;
      const left = host.side === 'left';
      const o = this.wallPoint(host.wall, 2n * BigInt(host.offset), left ? off.a2 : -off.b2);
      const [dx, dy] = this.wallLine(host.wall).d;
      return { ox: o.x, oy: o.y, f: left ? [-dy, dx] : [dy, -dx] };
    }
    const f = facingVector(host.rotation ?? 0);
    return { ox: Surd.of(host.position[0]), oy: Surd.of(host.position[1]), f };
  }
}
