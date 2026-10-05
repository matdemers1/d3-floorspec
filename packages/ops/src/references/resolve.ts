/**
 * Resolving references (chapter 3) against the working copy as it stands before an operation:
 * lengths, points, vectors, element selectors, sides and positions along a wall. Every result is
 * integers and IDs; every failure is the FS-OPS diagnostic chapter 7 names, pointing at the member
 * of the request that failed.
 */
import { Surd } from '@floorspec/engine';
import { fail, OpsFailure } from '../diagnostics.js';
import { asPoint, FacesCache, sideOf, type LevelFaces, type Side } from '../model/faces.js';
import { COLLECTIONS, type CollectionName, type WorkingCopy } from '../model/working.js';
import { getMember } from '../lib/json.js';
import { parseLength, MAX_LENGTH } from './length.js';

export type IPoint = readonly [bigint, bigint];

export interface Ctx {
  readonly wc: WorkingCopy;
  readonly faces: FacesCache;
}

const DIRECTIONS: Readonly<Record<Side, IPoint>> = {
  north: [0n, 1n],
  south: [0n, -1n],
  east: [1n, 0n],
  west: [-1n, 0n],
};

/** A BigInt as a JSON number, refusing anything Core cannot store exactly (2.1.1). */
export function toJsonInt(v: bigint, ptr: string): number {
  if (v > MAX_LENGTH || v < -MAX_LENGTH) fail('FS-OPS-012', `${v} is beyond the largest length Floorspec stores (2⁵³ − 1 base units)`, [], ptr);
  return Number(v);
}

// ── 3.1 lengths ───────────────────────────────────────────────────────────────

/** A length: a JSON integer of base units, or a string in the grammar of 3.1. */
export function resolveLength(v: unknown, ptr: string): bigint {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) fail('FS-OPS-001', 'a length is a JSON integer or a length string', [], ptr);
    return BigInt(v);
  }
  if (typeof v !== 'string') return fail('FS-OPS-001', 'a length is a JSON integer or a length string', [], ptr);
  const p = parseLength(v);
  if (!p.ok) return fail('FS-OPS-012', `${JSON.stringify(v)} is not a length: ${p.reason}`, [], ptr);
  toJsonInt(p.value, ptr);
  return p.value;
}

// ── 3.2 vectors and points ────────────────────────────────────────────────────

const dirRe = '(north|south|east|west)';

/** A vector: `[dx, dy]` of lengths, or `"<length> <direction>"`. */
export function resolveVector(v: unknown, ptr: string): IPoint {
  if (Array.isArray(v)) {
    if (v.length !== 2) fail('FS-OPS-001', 'a vector is [dx, dy] or "<length> <direction>"', [], ptr);
    return [resolveLength(v[0], `${ptr}/0`), resolveLength(v[1], `${ptr}/1`)];
  }
  if (typeof v !== 'string') return fail('FS-OPS-001', 'a vector is [dx, dy] or "<length> <direction>"', [], ptr);
  const m = new RegExp(`^\\s*(.+?)[ \\t]+${dirRe}\\s*$`, 'i').exec(v);
  if (!m) return fail('FS-OPS-012', `${JSON.stringify(v)} is not a vector: write "<length> <direction>", such as "2' east"`, [], ptr);
  const len = resolveLength(m[1]!, ptr);
  const u = DIRECTIONS[m[2]!.toLowerCase() as Side];
  return [len * u[0], len * u[1]];
}

export interface ResolvedPoint {
  readonly point: IPoint;
  /** Set when the point was written as a junction (4.1: "if it is a junction, use it"). */
  readonly junction?: string;
}

/** A junction's position, for a point written as a junction. */
function junctionPosition(ctx: Ctx, id: string, ptr: string): IPoint {
  const p = asPoint(getMember(ctx.wc.elementIn('junctions', id), 'position'));
  if (!p) return fail('FS-OPS-003', `junction ${id} has no position to read`, [id], ptr);
  return p;
}

const looksLikeReference = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) || /^(start|end)[ \t]+of[ \t]+/i.test(s.trim());

/**
 * A point: `[x, y]` of lengths; a junction (its position); `"<length> from <junction> toward
 * <junction>"`; or `"<length> <direction> of <junction>"`.
 */
export function resolvePoint(v: unknown, ptr: string, ctx: Ctx): ResolvedPoint {
  if (Array.isArray(v)) {
    if (v.length !== 2) fail('FS-OPS-001', 'a point is [x, y], a junction, or a point string', [], ptr);
    return { point: [resolveLength(v[0], `${ptr}/0`), resolveLength(v[1], `${ptr}/1`)] };
  }
  if (typeof v !== 'string') return fail('FS-OPS-001', 'a point is [x, y], a junction, or a point string', [], ptr);
  const toward = /^\s*(.+?)[ \t]+from[ \t]+(.+?)[ \t]+toward[ \t]+(.+?)\s*$/i.exec(v);
  if (toward) {
    const len = resolveLength(toward[1]!, ptr);
    const a = resolveElement(toward[2]!, ptr, ctx, JUNCTION);
    const b = resolveElement(toward[3]!, ptr, ctx, JUNCTION);
    const A = junctionPosition(ctx, a, ptr);
    const B = junctionPosition(ctx, b, ptr);
    const d: IPoint = [B[0] - A[0], B[1] - A[1]];
    const m = d[0] * d[0] + d[1] * d[1];
    if (m === 0n) return fail('FS-OPS-003', `${a} and ${b} are at the same position, so "toward" has no direction`, [], ptr);
    // A + len · d / |d| = A + len · d · √m / m, each coordinate rounded once (3.2).
    const k = Surd.sqrt(m).mulInt(len).divInt(m);
    return { point: [k.mulInt(d[0]).addInt(A[0]).round(), k.mulInt(d[1]).addInt(A[1]).round()] };
  }
  const of = new RegExp(`^\\s*(.+?)[ \\t]+${dirRe}[ \\t]+of[ \\t]+(.+?)\\s*$`, 'i').exec(v);
  if (of) {
    const len = resolveLength(of[1]!, ptr);
    const u = DIRECTIONS[of[2]!.toLowerCase() as Side];
    const j = resolveElement(of[3]!, ptr, ctx, JUNCTION);
    const J = junctionPosition(ctx, j, ptr);
    return { point: [J[0] + len * u[0], J[1] + len * u[1]] };
  }
  if (!looksLikeReference(v)) return fail('FS-OPS-012', `${JSON.stringify(v)} is not a point: write [x, y], a junction, "<length> from <junction> toward <junction>" or "<length> <direction> of <junction>"`, [], ptr);
  const j = resolveElement(v, ptr, ctx, JUNCTION);
  return { point: junctionPosition(ctx, j, ptr), junction: j };
}

// ── 3.3 element selectors ─────────────────────────────────────────────────────

export interface Accept {
  readonly collections: readonly CollectionName[];
  /** What the operation needs, for messages: "a wall", "a room". */
  readonly what: string;
}

export const ANY: Accept = { collections: COLLECTIONS, what: 'an element' };
export const JUNCTION: Accept = { collections: ['junctions'], what: 'a junction' };
export const LEVEL: Accept = { collections: ['levels'], what: 'a level' };
export const ROOM: Accept = { collections: ['rooms'], what: 'a room' };
export const WALL: Accept = { collections: ['walls'], what: 'a wall' };
export const EDGE: Accept = { collections: ['walls', 'separators'], what: 'a wall or separator' };
export const OPENING: Accept = { collections: ['openings'], what: 'an opening' };

type Structured =
  | { kind: 'side'; side: Side; edge: 'walls' | 'separators'; room: string }
  | { kind: 'between'; edge: 'walls' | 'separators'; rest: string }
  | { kind: 'end'; which: 'start' | 'end'; edge: string };

function parseStructured(s: string): Structured | undefined {
  const t = s.trim();
  let m = new RegExp(`^${dirRe}[ \\t]+(wall|separator)[ \\t]+of[ \\t]+(.+)$`, 'i').exec(t);
  if (m) return { kind: 'side', side: m[1]!.toLowerCase() as Side, edge: m[2]!.toLowerCase() === 'wall' ? 'walls' : 'separators', room: m[3]! };
  m = /^(wall|separator)[ \t]+between[ \t]+(.+)$/i.exec(t);
  if (m) return { kind: 'between', edge: m[1]!.toLowerCase() === 'wall' ? 'walls' : 'separators', rest: m[2]! };
  m = /^(start|end)[ \t]+of[ \t]+(.+)$/i.exec(t);
  if (m) return { kind: 'end', which: m[1]!.toLowerCase() as 'start' | 'end', edge: m[2]! };
  return undefined;
}

/** Rooms whose name equals s, ignoring case (3.3). */
/**
 * Unicode case folding (3.3), per code point: full upper-casing then lower-casing folds what
 * simple lower-casing misses (ß → ss, ſ → s, ﬁ → fi), and per code point so no context rule (Greek
 * final sigma) applies.
 */
export function caseFold(s: string): string {
  let out = '';
  for (const c of s) out += c.toUpperCase().toLowerCase();
  return out;
}

/** Rooms whose name equals s under case folding (3.3). */
function roomsNamed(ctx: Ctx, s: string): string[] {
  const want = caseFold(s);
  return ctx.wc.ids('rooms').filter((id) => {
    const n = getMember(ctx.wc.elementIn('rooms', id), 'name');
    return typeof n === 'string' && caseFold(n) === want;
  });
}

/**
 * Resolve an element reference — an ID or a selector (3.3) — to the ID of one element of an
 * accepted collection. FS-OPS-003 when nothing matches, FS-OPS-004 when several do.
 */
export function resolveElement(s: string, ptr: string, ctx: Ctx, accept: Accept): string {
  const { wc } = ctx;
  // A string with a keyword form is read only as that form (3.3).
  const st = parseStructured(s);
  if (st) {
    const id = resolveStructured(st, s, ptr, ctx);
    const c = wc.collectionOf(id);
    if (!c || !accept.collections.includes(c)) return fail('FS-OPS-003', `${JSON.stringify(s)} is ${id}, and this needs ${accept.what}`, [], ptr);
    return id;
  }
  // Any other string is an ID, a room name, or both: every element of the expected collection it
  // names that way is a match.
  const coll = wc.collectionOf(s);
  const matches = [...new Set([...(coll !== undefined && accept.collections.includes(coll) ? [s] : []), ...(accept.collections.includes('rooms') ? roomsNamed(ctx, s) : [])])];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return fail('FS-OPS-004', `${JSON.stringify(s)} names ${matches.length} elements: ${[...matches].sort().join(', ')}`, matches, ptr);
  if (coll !== undefined) return fail('FS-OPS-003', `${s} is in ${coll}, and this needs ${accept.what}`, [], ptr);
  return fail('FS-OPS-003', `nothing matches ${JSON.stringify(s)}: there is no such ${accept.what.replace(/^an? /, '')}`, [], ptr);
}

/** The level a room is on and the face its anchor is in, or FS-OPS-007 (3.4.1). */
export function roomFace(ctx: Ctx, room: string, ptr: string): { level: string; faces: LevelFaces; face: number } {
  const r = ctx.wc.elementIn('rooms', room);
  const level = getMember(r, 'level');
  if (typeof level !== 'string') return fail('FS-OPS-007', `room ${room} is on no level, so it has no face`, [], ptr);
  const faces = ctx.faces.get(level);
  if (faces.broken !== undefined) return fail('FS-OPS-007', `level ${level} has no faces to read: ${faces.broken}`, [level], ptr);
  const anchor = asPoint(getMember(r, 'anchor'));
  if (!anchor) return fail('FS-OPS-007', `room ${room} has no anchor, so it is in no face of level ${level}`, [level], ptr);
  const place = faces.place(anchor);
  if (place.kind !== 'face') return fail('FS-OPS-007', `the anchor of room ${room} is in no enclosed face of level ${level}: ${place.why}`, [level], ptr);
  return { level, faces, face: place.face };
}

function resolveStructured(st: Structured, s: string, ptr: string, ctx: Ctx): string {
  switch (st.kind) {
    case 'side': {
      const room = resolveElement(st.room, ptr, ctx, ROOM);
      const { faces, face } = roomFace(ctx, room, ptr);
      const matches = new Set<string>();
      for (const h of faces.faces[face]!.outer.halfEdges) {
        const e = faces.edges[h >> 1]!;
        if (e.kind === st.edge && sideOf(faces.outwardNormal(h)) === st.side) matches.add(e.id);
      }
      return one([...matches], s, ptr);
    }
    case 'between': {
      const [a, b] = splitRooms(st.rest, ptr, ctx);
      const fa = roomFace(ctx, a, ptr);
      const fb = roomFace(ctx, b, ptr);
      if (fa.level !== fb.level) return fail('FS-OPS-003', `${a} and ${b} are on different levels, so no ${st.edge === 'walls' ? 'wall' : 'separator'} is between them`, [], ptr);
      const matches: string[] = [];
      fa.faces.edges.forEach((e, i) => {
        if (e.kind !== st.edge) return;
        const l = fa.faces.faceLeftOf(2 * i);
        const r = fa.faces.faceLeftOf(2 * i + 1);
        if ((l === fa.face && r === fb.face) || (l === fb.face && r === fa.face)) matches.push(e.id);
      });
      return one(matches, s, ptr);
    }
    case 'end': {
      const edge = resolveElement(st.edge, ptr, ctx, EDGE);
      const j = getMember(ctx.wc.element(edge), st.which);
      if (typeof j !== 'string' || !ctx.wc.elementIn('junctions', j)) return fail('FS-OPS-003', `the ${st.which} of ${edge} is not a junction`, [edge], ptr);
      return j;
    }
  }
}

/** `<room> and <room>`: every split at "and" is tried, and exactly one must resolve (3.3). */
function splitRooms(rest: string, ptr: string, ctx: Ctx): [string, string] {
  const re = /[ \t]+and[ \t]+/gi;
  const splits: [string, string][] = [];
  for (let m = re.exec(rest); m; m = re.exec(rest)) splits.push([rest.slice(0, m.index), rest.slice(m.index + m[0].length)]);
  if (splits.length === 0) return fail('FS-OPS-003', `${JSON.stringify(rest)} does not name two rooms: write "<room> and <room>"`, [], ptr);
  if (splits.length === 1) return [resolveElement(splits[0]![0], ptr, ctx, ROOM), resolveElement(splits[0]![1], ptr, ctx, ROOM)];
  const resolved: [string, string][] = [];
  for (const [l, r] of splits) {
    try {
      resolved.push([resolveElement(l, ptr, ctx, ROOM), resolveElement(r, ptr, ctx, ROOM)]);
    } catch (e) {
      if (!(e instanceof OpsFailure)) throw e;
    }
  }
  if (resolved.length === 1) return resolved[0]!;
  if (resolved.length === 0) return fail('FS-OPS-003', `no reading of ${JSON.stringify(rest)} names two rooms`, [], ptr);
  const rooms = [...new Set(resolved.flat())];
  return fail('FS-OPS-004', `${JSON.stringify(rest)} can be read ${resolved.length} ways`, rooms, ptr);
}

function one(matches: string[], s: string, ptr: string): string {
  if (matches.length === 0) return fail('FS-OPS-003', `nothing matches ${JSON.stringify(s)}`, [], ptr);
  if (matches.length > 1) return fail('FS-OPS-004', `${JSON.stringify(s)} matches ${matches.length} elements: ${[...matches].sort().join(', ')}`, matches, ptr);
  return matches[0]!;
}

// ── 3.5 positions along a wall ────────────────────────────────────────────────

/** The squared length of an edge's location line, and its junction positions. */
export function edgeGeometry(ctx: Ctx, edge: string, ptr: string): { S: IPoint; E: IPoint; d: IPoint; m: bigint } {
  const e = ctx.wc.element(edge);
  const s = getMember(e, 'start');
  const t = getMember(e, 'end');
  const S = typeof s === 'string' ? asPoint(getMember(ctx.wc.elementIn('junctions', s), 'position')) : undefined;
  const E = typeof t === 'string' ? asPoint(getMember(ctx.wc.elementIn('junctions', t), 'position')) : undefined;
  if (!S || !E) return fail('FS-OPS-003', `${edge} does not run between two junctions with positions`, [edge], ptr);
  const d: IPoint = [E[0] - S[0], E[1] - S[1]];
  return { S, E, d, m: d[0] * d[0] + d[1] * d[1] };
}

/**
 * A position along a wall (3.5): `"centered"`, `"<length> from start"`, `"<length> from end"`, or
 * an offset. L is the length of the wall's location line (√m, exact) and w the width placed.
 */
export function resolvePosition(v: unknown, ptr: string, m: bigint, w: bigint): bigint {
  const L = Surd.sqrt(m);
  if (typeof v === 'string') {
    if (/^\s*centered\s*$/i.test(v)) return L.addInt(-w).divInt(2n).round();
    const from = /^\s*(.+?)[ \t]+from[ \t]+(start|end)\s*$/i.exec(v);
    if (from) {
      const len = resolveLength(from[1]!, ptr);
      return from[2]!.toLowerCase() === 'start' ? len : L.addInt(-len - w).round();
    }
  }
  return resolveLength(v, ptr);
}
