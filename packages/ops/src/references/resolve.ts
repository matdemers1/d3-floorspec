/**
 * Resolving references (chapter 3) against the working copy as it stands before an operation:
 * lengths, points, vectors, element selectors, sides and positions along a wall. Every result is
 * integers and IDs; every failure is the FS-OPS diagnostic chapter 7 names, pointing at the member
 * of the request that failed.
 */
import { polylineLength, Surd } from '@floorspec/engine';
import { fail, OpsFailure } from '../diagnostics.js';
import { arcPolylineOf, asPoint, FacesCache, sideOf, type LevelFaces, type Side } from '../model/faces.js';
import { ITEMS, type ElementKind, type WorkingCopy } from '../model/working.js';
import { cmpStr, getMember } from '../lib/json.js';
import { parseArea, parseLength, MAX_LENGTH } from './length.js';

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

// ── 3.6 areas (Ops 0.2) ───────────────────────────────────────────────────────

/**
 * An area: a JSON integer of square base units as it is, or a string in the grammar of 3.6. Whether
 * it is in range is decided when the batch is validated, so it is not checked here.
 */
export function resolveArea(v: unknown, ptr: string): number {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) fail('FS-OPS-001', 'an area is a JSON integer or an area string', [], ptr);
    return v;
  }
  if (typeof v !== 'string') return fail('FS-OPS-012', 'an area is a JSON integer or an area string', [], ptr);
  const p = parseArea(v);
  if (!p.ok) return fail('FS-OPS-012', `${JSON.stringify(v)} is not an area: ${p.reason}`, [], ptr);
  return Number(p.value);
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
  /** The kinds of element that count as matches; null for any element (0.3). */
  readonly kinds: readonly ElementKind[] | null;
  /** What the operation needs, for messages: "a wall", "a room". */
  readonly what: string;
}

export const ANY: Accept = { kinds: null, what: 'an element' };
export const BUILDING: Accept = { kinds: ['buildings'], what: 'a building' };
export const JUNCTION: Accept = { kinds: ['junctions'], what: 'a junction' };
export const LEVEL: Accept = { kinds: ['levels'], what: 'a level' };
export const ROOM: Accept = { kinds: ['rooms'], what: 'a room' };
export const WALL: Accept = { kinds: ['walls'], what: 'a wall' };
export const EDGE: Accept = { kinds: ['walls', 'separators'], what: 'a wall or separator' };
export const OPENING: Accept = { kinds: ['openings'], what: 'an opening' };
/** Ops 0.2: a program item (3.3). */
export const ITEM: Accept = { kinds: [ITEMS], what: 'a program item' };
/** Ops 0.2: an extension element (3.3). */
export const EXTENSION_ELEMENT: Accept = { kinds: ['ext'], what: 'an extension element' };

const accepts = (a: Accept, k: ElementKind): boolean => a.kinds === null || a.kinds.includes(k);

const ws = '[ \\t]';
const SIDE_SEL = new RegExp(`^${ws}*${dirRe}${ws}+(wall|separator)${ws}+of${ws}+([\\s\\S]+?)${ws}*$`, 'i');
const BETWEEN_SEL = new RegExp(`^${ws}*(wall|separator)${ws}+between${ws}+([\\s\\S]+?)${ws}*$`, 'i');
const END_SEL = new RegExp(`^${ws}*(start|end)${ws}+of${ws}+([\\s\\S]+?)${ws}*$`, 'i');
/** Ops 0.2: `item <item>` and `brief of <room>`. */
const ITEM_SEL = new RegExp(`^${ws}*item${ws}+([\\s\\S]+?)${ws}*$`, 'i');
const BRIEF_SEL = new RegExp(`^${ws}*brief${ws}+of${ws}+([\\s\\S]+?)${ws}*$`, 'i');

/** Is this string an `end of`/`start of` junction reference (3.2: a point that is a junction)? */
export const isEndSelector = (s: string): boolean => END_SEL.test(s);

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

type Match = readonly [ElementKind, string];

/**
 * A plain string (no keyword form): an ID, and the names it is — rooms' wherever a room may be
 * meant, and (Ops 0.2) program items' and extension elements' only where the member expects them.
 */
function plain(ctx: Ctx, s: string, accept: Accept): Match[] {
  const out: Match[] = [];
  const k = ctx.wc.kindOf(s);
  if (k !== undefined && accepts(accept, k)) out.push([k, s]);
  const want = caseFold(s);
  const named = (kind: ElementKind, elements: Iterable<[string, unknown]>): void => {
    for (const [id, e] of elements) {
      const n = getMember(e, 'name');
      if (typeof n === 'string' && caseFold(n) === want) out.push([kind, id]);
    }
  };
  if (accepts(accept, 'rooms')) named('rooms', Object.entries(ctx.wc.collection('rooms') ?? {}));
  if (accept.kinds?.includes(ITEMS)) named(ITEMS, Object.entries(ctx.wc.items()));
  if (accept.kinds?.includes('ext')) named('ext', ctx.wc.extElements().map((x) => [x.id, x.element] as [string, unknown]));
  return out;
}

/** The one match, or FS-OPS-003 (none) or FS-OPS-004 (several, every match named). */
function unique(matches: readonly Match[], s: string, ptr: string, accept: Accept): string {
  const ids = [...new Set(matches.filter(([k]) => accepts(accept, k)).map(([, id]) => id))].sort(cmpStr);
  if (ids.length === 0) return fail('FS-OPS-003', `nothing matches ${JSON.stringify(s)}: there is no such ${accept.what.replace(/^an? /, '')}`, [], ptr);
  if (ids.length > 1) return fail('FS-OPS-004', `${JSON.stringify(s)} matches ${ids.length} elements: ${ids.join(', ')}`, ids, ptr);
  return ids[0]!;
}

/** `<room>`: a room's ID or name (3.3) — never a keyword form. */
export function resolveRoom(s: string, ptr: string, ctx: Ctx): string {
  return unique(plain(ctx, s, ROOM), s, ptr, ROOM);
}

/** Ops 0.2: a program item — an ID or a name, or `item <item>` or `brief of <room>` (3.3). */
export function resolveItem(s: string, ptr: string, ctx: Ctx): string {
  return resolveElement(s, ptr, ctx, ITEM);
}

/**
 * Resolve an element reference — an ID or a selector (3.3) — to the ID of one element of an
 * accepted kind. A string with a keyword form is read only as that form. FS-OPS-003 when nothing
 * matches, FS-OPS-004 when several do.
 */
export function resolveElement(s: string, ptr: string, ctx: Ctx, accept: Accept): string {
  let m = SIDE_SEL.exec(s);
  if (m) {
    const edge = m[2]!.toLowerCase() === 'wall' ? 'walls' : 'separators';
    const side = m[1]!.toLowerCase() as Side;
    const room = resolveRoom(m[3]!, ptr, ctx);
    const { faces, face } = roomFace(ctx, room, ptr);
    const found: Match[] = [];
    for (const h of faces.faces[face]!.outer.halfEdges) {
      const e = faces.edges[h >> 1]!;
      if (e.kind === edge && sideOf(faces.outwardNormal(h)) === side) found.push([edge, e.id]);
    }
    return unique(found, s, ptr, accept);
  }
  m = BETWEEN_SEL.exec(s);
  if (m) {
    const edge = m[1]!.toLowerCase() === 'wall' ? 'walls' : 'separators';
    const [a, b] = splitRooms(m[2]!, ptr, ctx);
    const fa = roomFace(ctx, a, ptr);
    const fb = roomFace(ctx, b, ptr);
    const found: Match[] = [];
    if (fa.level === fb.level)
      fa.faces.edges.forEach((e, i) => {
        if (e.kind !== edge) return;
        const l = fa.faces.faceLeftOf(2 * i);
        const r = fa.faces.faceLeftOf(2 * i + 1);
        if ((l === fa.face && r === fb.face) || (l === fb.face && r === fa.face)) found.push([edge, e.id]);
      });
    return unique(found, s, ptr, accept);
  }
  if (ctx.wc.v02) {
    m = ITEM_SEL.exec(s);
    if (m) return unique(plain(ctx, m[1]!, ITEM), s, ptr, accept);
    m = BRIEF_SEL.exec(s);
    if (m) {
      const room = resolveRoom(m[1]!, ptr, ctx);
      const brief = getMember(ctx.wc.elementIn('rooms', room), 'brief');
      if (typeof brief !== 'string' || !Object.hasOwn(ctx.wc.items(), brief)) return fail('FS-OPS-003', `${room} fulfils no program item: it has no brief that names one`, [room], ptr);
      return unique([[ITEMS, brief]], s, ptr, accept);
    }
  }
  m = END_SEL.exec(s);
  if (m) {
    const edge = resolveElement(m[2]!, ptr, ctx, EDGE);
    const which = m[1]!.toLowerCase();
    const j = getMember(ctx.wc.element(edge), which);
    if (typeof j !== 'string' || !ctx.wc.elementIn('junctions', j)) return fail('FS-OPS-003', `the ${which} of ${edge} is not a junction`, [edge], ptr);
    return unique([['junctions', j]], s, ptr, accept);
  }
  return unique(plain(ctx, s, accept), s, ptr, accept);
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

/**
 * Which side of a wall a room's face is on (4.2's and 4.10's `toward`): `left` when it is the face
 * on the wall's left (as it runs start → end) and not on its right, `right` the other way round,
 * and undefined when it is on neither or both — or when the wall is not an edge of that level.
 */
export function sideToward(ctx: Ctx, wall: string, room: string, ptr: string): 'left' | 'right' | undefined {
  const rf = roomFace(ctx, room, ptr);
  const i = rf.faces.edgeIndex(wall);
  if (i < 0) return undefined;
  const left = rf.faces.faceLeftOf(2 * i);
  const right = rf.faces.faceLeftOf(2 * i + 1);
  if (left === rf.face && right !== rf.face) return 'left';
  if (right === rf.face && left !== rf.face) return 'right';
  return undefined;
}

/** `<room> and <room>`: every split at "and" is tried, and exactly one must resolve (3.3). */
function splitRooms(rest: string, ptr: string, ctx: Ctx): [string, string] {
  const re = /[ \t]+and[ \t]+/gi;
  const splits: [string, string][] = [];
  for (let m = re.exec(rest); m; m = re.exec(rest)) splits.push([rest.slice(0, m.index), rest.slice(m.index + m[0].length)]);
  if (splits.length === 0) return fail('FS-OPS-003', `${JSON.stringify(rest)} does not name two rooms: write "<room> and <room>"`, [], ptr);
  const resolved: [string, string][] = [];
  let first: OpsFailure | undefined;
  for (const [l, r] of splits) {
    try {
      resolved.push([resolveRoom(l, ptr, ctx), resolveRoom(r, ptr, ctx)]);
    } catch (e) {
      if (!(e instanceof OpsFailure)) throw e;
      first ??= e;
    }
  }
  if (resolved.length === 0) throw first!;
  const distinct = [...new Map(resolved.map((p) => [`${p[0]}\u0000${p[1]}`, p])).values()];
  if (distinct.length === 1) return distinct[0]!;
  const rooms = [...new Set(distinct.flat())];
  return fail('FS-OPS-004', `${JSON.stringify(rest)} can be read ${distinct.length} ways`, rooms, ptr);
}

// ── 3.5 positions along a wall ────────────────────────────────────────────────

/**
 * The squared length of an edge's chord, its junction positions, and L, the exact length of its location
 * line (3.5) — for an arc edge, its length along its polyline (Core 21.6), an integer.
 */
export function edgeGeometry(ctx: Ctx, edge: string, ptr: string): { S: IPoint; E: IPoint; d: IPoint; m: bigint; L: Surd } {
  const e = ctx.wc.element(edge);
  const s = getMember(e, 'start');
  const t = getMember(e, 'end');
  const S = typeof s === 'string' ? asPoint(getMember(ctx.wc.elementIn('junctions', s), 'position')) : undefined;
  const E = typeof t === 'string' ? asPoint(getMember(ctx.wc.elementIn('junctions', t), 'position')) : undefined;
  if (!S || !E) return fail('FS-OPS-003', `${edge} does not run between two junctions with positions`, [edge], ptr);
  const d: IPoint = [E[0] - S[0], E[1] - S[1]];
  const m = d[0] * d[0] + d[1] * d[1];
  const arc = arcPolylineOf(ctx.wc, edge, S, E);
  return { S, E, d, m, L: arc ? Surd.of(polylineLength(arc)) : Surd.sqrt(m) };
}

/**
 * A position along a wall (3.5): `"centered"`, `"<length> from start"`, `"<length> from end"`, or
 * an offset. L is the exact length of the wall's location line (edgeGeometry) and w the width placed.
 */
export function resolvePosition(v: unknown, ptr: string, L: Surd, w: bigint): bigint {
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
