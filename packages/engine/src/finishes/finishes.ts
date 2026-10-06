/**
 * Materials, assets and finishes (Core 0.3, chapter 18): the material and finish invariants
 * FS-INV-1001 to FS-INV-1004, the package invariants FS-INV-1005 to FS-INV-1007 of a package
 * validator (18.4), the derived `finishes` (18.6), and the texture space of a wall's face (18.3).
 *
 * Nothing here is geometry beyond 18.5.3's exact length test (to² ≤ dx² + dy²) and the integer
 * rectangle tests of 18.5.2 and 18.5.4. Which room a wall's side faces is read from the half-edges
 * of its level's faces (6.1): a half-edge runs with its face on its left, so the wall taken from its
 * start to its end has the face on its left side, and taken the other way, on its right.
 */
import { Surd } from '../exact/surd.js';
import { sha256, toHex } from '../hash/sha256.js';
import { effectiveLayers, entries, get, ipoint, wallArc, wallElevations, type FinishRegion, type FloorspecDocument, type Wall } from '../model/document.js';
import { polylineLength } from '../geometry/arcs.js';
import { MAPS, SIDES } from '../validate/references.js';
import type { LevelAnalysis } from '../validate/invariants.js';

/** 18.2.2: the media types a texture's map may have. */
export const MAP_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/ktx2'];

export type Side = (typeof SIDES)[number];

export interface FinishProblem {
  readonly code: 'FS-INV-1001' | 'FS-INV-1002' | 'FS-INV-1003' | 'FS-INV-1004';
  readonly elements: string[];
  /** Where in the document: the region, the pair's second region, or the material's map. */
  readonly path: (string | number)[];
}

const empty = (r: FinishRegion): boolean => r.to <= r.from || r.top <= r.bottom;
const overlap = (a: FinishRegion, b: FinishRegion): boolean =>
  Math.max(a.from, b.from) < Math.min(a.to, b.to) && Math.max(a.bottom, b.bottom) < Math.min(a.top, b.top);

/**
 * FS-INV-1001 to FS-INV-1004 (10.3), for every region and every material: 1002 and 1003 are not
 * evaluated for a region with 1001, and 1002 does not test the top of a region on a wall that has
 * FS-INV-112 (`noTop`).
 */
export function finishInvariants(doc: FloorspecDocument, noTop: (wall: string) => boolean): FinishProblem[] {
  const out: FinishProblem[] = [];
  for (const [wid, w] of entries(doc.walls)) {
    if (!w.finishes) continue;
    const S = ipoint(get(doc.junctions, w.start)!.position);
    const E = ipoint(get(doc.junctions, w.end)!.position);
    const D = (E[0] - S[0]) ** 2n + (E[1] - S[1]) ** 2n;
    const el = noTop(wid) ? undefined : wallElevations(doc, w);
    const height = el ? el.top - el.base : undefined;
    for (const side of SIDES) {
      const regions = w.finishes[side]?.regions ?? [];
      const ok: { r: FinishRegion; i: number }[] = [];
      regions.forEach((r, i) => {
        const path = ['walls', wid, 'finishes', side, 'regions', i];
        if (empty(r)) {
          out.push({ code: 'FS-INV-1001', elements: [wid], path });
          return;
        }
        ok.push({ r, i });
        const to = BigInt(r.to);
        const arc = wallArc(doc, wid);                     // 21.6.2: an arc wall's length; none when unfit (10.3)
        const past = arc === 'unfit' ? false : arc ? to > polylineLength(arc) : to * to > D;
        if (past || (height !== undefined && BigInt(r.top) > height)) out.push({ code: 'FS-INV-1002', elements: [wid], path });
      });
      for (let a = 0; a < ok.length; a++)
        for (let b = a + 1; b < ok.length; b++)
          if (overlap(ok[a]!.r, ok[b]!.r)) out.push({ code: 'FS-INV-1003', elements: [wid], path: ['walls', wid, 'finishes', side, 'regions', ok[b]!.i] });
    }
  }
  for (const [mid, m] of entries(doc.materials)) {
    const tex = m.texture;
    if (!tex) continue;
    for (const k of MAPS) {
      const aid = tex[k];
      if (aid === undefined) continue;
      const a = get(doc.assets, aid)!;
      if (!MAP_MEDIA_TYPES.includes(a.mediaType)) out.push({ code: 'FS-INV-1004', elements: [mid, aid], path: ['materials', mid, 'texture', k] });
    }
  }
  return out;
}

/**
 * The files of a document's package (18.4): its directory, each file by its path relative to it,
 * `/` between names. A path names one file exactly — compared as a sequence of code points, case
 * and all, never percent-decoded — so a package is looked up by exact key, never by opening a file
 * on a file system that may fold case.
 */
export class Package {
  private readonly files: ReadonlyMap<string, Uint8Array>;
  constructor(files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>) {
    this.files = files instanceof Map ? new Map(files) : new Map(Object.entries(files));
  }
  /** The bytes of the file at exactly this path, or undefined when the package has none there. */
  file(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }
  get paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

export interface PackageProblem {
  readonly code: 'FS-INV-1005' | 'FS-INV-1006' | 'FS-INV-1007';
  readonly asset: string;
}

/** FS-INV-1005 to FS-INV-1007 of a package validator (18.4.2, 18.4.3); 1006 and 1007 not for an asset with 1005. */
export function packageInvariants(doc: FloorspecDocument, pkg: Package): PackageProblem[] {
  const out: PackageProblem[] = [];
  for (const [aid, a] of entries(doc.assets)) {
    if (a.path === undefined) continue;
    const data = pkg.file(a.path);
    if (!data) {
      out.push({ code: 'FS-INV-1005', asset: aid });
      continue;
    }
    if (toHex(sha256(data)) !== a.sha256) out.push({ code: 'FS-INV-1006', asset: aid });
    if (a.byteLength !== undefined && a.byteLength !== data.length) out.push({ code: 'FS-INV-1007', asset: aid });
  }
  return out;
}

// ── derived (18.6) ───────────────────────────────────────────────────────────

export interface DerivedRoomFinish {
  floor?: string;
  ceiling?: string;
}

export interface DerivedFaceFinish {
  /** The room the face faces, when it faces one. */
  room?: string;
  /** The material that finishes the rest of the face, when one resolves. */
  material?: string;
  /** The column of 18.6's table the material came from. */
  source?: 'face' | 'room' | 'layer';
  /** The face's regions, as the wall lists them. */
  regions: FinishRegion[];
}

export interface DerivedFinishes {
  rooms: Record<string, DerivedRoomFinish>;
  walls: Record<string, { left?: DerivedFaceFinish; right?: DerivedFaceFinish }>;
}

const setMember = <T>(obj: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
};

/** 18.6: `wall/side` → the room that side faces, for every side of a wall that faces a room. */
export function facingRooms(levels: ReadonlyMap<string, LevelAnalysis>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, la] of levels) {
    const g = la.geometry;
    if (!g) continue;
    for (const [rid, fi] of la.roomFaces) {
      const f = g.faces[fi]!;
      for (const cycle of [f.outer, ...f.inner])
        for (const h of cycle.halfEdges) {
          const e = g.edges[h >> 1]!;
          // An arc wall's segments face what the wall faces (21.3).
          if (e.kind === 'wall') out.set(`${e.src ?? e.id}/${(h & 1) === 0 ? 'left' : 'right'}`, rid);
        }
    }
  }
  return out;
}

/** The resolved finish of one face of a wall (18.6), or undefined when it resolves to nothing and has no regions. */
export function faceFinish(doc: FloorspecDocument, w: Wall, side: Side, room: string | undefined): DerivedFaceFinish | undefined {
  const face = w.finishes?.[side] ?? {};
  const layers = effectiveLayers(doc, w) ?? [];
  const layer = layers.length ? (side === 'left' ? layers[0]! : layers[layers.length - 1]!) : undefined;
  const v: DerivedFaceFinish = { regions: [] };
  if (room !== undefined) v.room = room;
  const roomFinish = room === undefined ? undefined : get(doc.rooms, room)?.wallFinish;
  if (face.material !== undefined) Object.assign(v, { material: face.material, source: 'face' });
  else if (roomFinish !== undefined) Object.assign(v, { material: roomFinish, source: 'room' });
  else if (layer?.material !== undefined) Object.assign(v, { material: layer.material, source: 'layer' });
  v.regions = (face.regions ?? []).map((r) => ({ from: r.from, to: r.to, bottom: r.bottom, top: r.top, material: r.material }));
  if (v.material === undefined && !v.regions.length) return undefined;
  // Members in the order the conformance suite writes them.
  return {
    ...(v.room !== undefined && { room: v.room }),
    ...(v.material !== undefined && { material: v.material, source: v.source }),
    regions: v.regions,
  };
}

/** 18.6: every room's floor and ceiling finish, and every side of every wall that resolves to a material or has regions. */
export function deriveFinishes(doc: FloorspecDocument, levels: ReadonlyMap<string, LevelAnalysis>): DerivedFinishes {
  const rooms: Record<string, DerivedRoomFinish> = {};
  for (const [rid, r] of entries(doc.rooms)) {
    const v: DerivedRoomFinish = {};
    if (r.floorFinish !== undefined) v.floor = r.floorFinish;
    if (r.ceilingFinish !== undefined) v.ceiling = r.ceilingFinish;
    if (v.floor !== undefined || v.ceiling !== undefined) setMember(rooms, rid, v);
  }
  const facing = facingRooms(levels);
  const walls: DerivedFinishes['walls'] = {};
  for (const [wid, w] of entries(doc.walls))
    for (const side of SIDES) {
      const v = faceFinish(doc, w, side, facing.get(`${wid}/${side}`));
      if (!v) continue;
      if (!Object.hasOwn(walls, wid)) setMember(walls, wid, {});
      walls[wid]![side] = v;
    }
  return { rooms, walls };
}

// ── texture space (18.3) ─────────────────────────────────────────────────────

/**
 * 18.3: the exact surface coordinates (s, t) of the plan point `point` at elevation `z` on the `side`
 * face of wall `wall` — or, given one of that face's regions, in the region's coordinates, from its
 * lower corner on the left of a person facing it: (from, bottom) on a right face, (to, bottom) on a
 * left one. Nothing derived reports these; they pin the definition a renderer and an exporter follow.
 */
export function surfaceST(
  doc: FloorspecDocument,
  wall: string,
  side: Side,
  point: readonly [number, number],
  z: number,
  region?: Pick<FinishRegion, 'from' | 'to' | 'bottom'>,
): { s: Surd; t: bigint } {
  const w = get(doc.walls, wall)!;
  const S = ipoint(get(doc.junctions, w.start)!.position);
  const E = ipoint(get(doc.junctions, w.end)!.position);
  const d = [E[0] - S[0], E[1] - S[1]] as const;
  const D = d[0] * d[0] + d[1] * d[1];
  const P = ipoint(point);
  // (P − S) · e = ((P − S) · d) / |d| = ((P − S) · d) · √D / D
  const along = Surd.sqrt(D).mulInt((P[0] - S[0]) * d[0] + (P[1] - S[1]) * d[1]).divInt(D);
  let s = side === 'right' ? along : along.neg();
  let t = BigInt(z) - wallElevations(doc, w)!.base;
  if (region) {
    s = side === 'right' ? s.addInt(-BigInt(region.from)) : s.addInt(BigInt(region.to));
    t -= BigInt(region.bottom);
  }
  return { s, t };
}
