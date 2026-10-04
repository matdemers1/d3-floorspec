/**
 * Steps 2–4 of the transaction (1.2), one operation at a time: resolve the operation's references
 * against the working copy as it stands, expand a composite into the exact primitives chapter 4
 * defines, and apply them. Returns the resolved primitives, for the echo (1.4).
 */
import { predicates, roundHalfEvenRational, Surd } from '@floorspec/engine';
import { fail } from './diagnostics.js';
import { asPoint, SIDE_UNIT, type LevelFaces } from './model/faces.js';
import { RESERVED_TARGETS, type CollectionName, type ReservedTarget } from './model/working.js';
import { applyPrimitive } from './primitives.js';
import {
  ANY,
  EDGE,
  JUNCTION,
  edgeGeometry,
  LEVEL,
  OPENING,
  resolveContent,
  resolveElement,
  resolveLength,
  resolvePoint,
  resolvePosition,
  resolveVector,
  ROOM,
  roomFace,
  toJsonInt,
  WALL,
  type Ctx,
  type IPoint,
} from './references/resolve.js';
import type { Operation, Point, ResolvedPrimitive, Side } from './types.js';
import { cmpStr, escapeToken, getMember, isObject, parsePointer, setMember, type JsonObject } from './lib/json.js';

const pt = (p: IPoint, ptr: string): Point => [toJsonInt(p[0], ptr), toJsonInt(p[1], ptr)];
const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(cmpStr);

/** The wall members drawWall and addWall carry to the element, in Core §5.2's order. */
const WALL_MEMBER_NAMES = ['type', 'layers', 'justification', 'base', 'top', 'name', 'extensions', 'extras'] as const;

/** Resolve, expand and apply operation `index` of the batch. */
export function runOperation(ctx: Ctx, op: Operation, index: number): ResolvedPrimitive[] {
  const base = `/batch/${index}`;
  const out: ResolvedPrimitive[] = [];
  /** Apply a primitive now and record it. */
  const emit = (p: ResolvedPrimitive, idPtr = `${base}/id`): void => {
    applyPrimitive(ctx.wc, p, { op: base, id: idPtr });
    out.push(p);
  };
  const o = op as unknown as JsonObject;
  const has = (m: string): boolean => Object.hasOwn(o, m);

  switch (op.op) {
    // ── primitives (2.5: references are resolved first, like any composite's) ──
    case 'addElement': {
      const id = op.id ?? ctx.wc.mint(op.collection);
      const element = resolveContent(op.collection, [], op.element, `${base}/element`, ctx) as Record<string, unknown>;
      emit({ op: 'addElement', collection: op.collection, id, element });
      break;
    }
    case 'addJunction':
    case 'addWall':
    case 'addSeparator': {
      const collection: CollectionName = op.op === 'addJunction' ? 'junctions' : op.op === 'addWall' ? 'walls' : 'separators';
      const id = op.id ?? ctx.wc.mint(collection);
      const p: JsonObject = { op: op.op, id };
      for (const k of Object.keys(o)) if (k !== 'op' && k !== 'id') setMember(p, k, resolveContent(collection, [k], o[k], `${base}/${escapeToken(k)}`, ctx));
      emit(p as unknown as ResolvedPrimitive);
      break;
    }
    case 'removeElement': {
      const id = resolveElement(op.id, `${base}/id`, ctx, ANY);
      emit({ op: 'removeElement', id, ...(has('cascade') && { cascade: op.cascade === true }) });
      break;
    }
    case 'setProperty':
    case 'unsetProperty': {
      const id = (RESERVED_TARGETS as readonly string[]).includes(op.id) ? (op.id as ReservedTarget) : resolveElement(op.id, `${base}/id`, ctx, ANY);
      if (op.op === 'unsetProperty') emit({ op: 'unsetProperty', id, path: op.path });
      else {
        const tokens = parsePointer(op.path) ?? [];
        const targetKind = id.startsWith('$') ? id : (ctx.wc.collectionOf(id) ?? '');
        emit({ op: 'setProperty', id, path: op.path, value: resolveContent(targetKind, tokens, op.value, `${base}/value`, ctx) });
      }
      break;
    }
    case 'moveJunction': {
      const id = resolveElement(op.id, `${base}/id`, ctx, JUNCTION);
      const to = resolvePoint(op.to, `${base}/to`, ctx).point;
      emit({ op: 'moveJunction', id, to: pt(to, `${base}/to`) });
      break;
    }

    // ── 4.1 drawWall, drawSeparator ──
    case 'drawWall':
    case 'drawSeparator': {
      const level = resolveElement(op.level, `${base}/level`, ctx, LEVEL);
      const from = resolvePoint(op.from, `${base}/from`, ctx);
      const to = resolvePoint(op.to, `${base}/to`, ctx);
      const ends: string[] = [];
      for (const [p, m] of [
        [from, 'from'],
        [to, 'to'],
      ] as const) {
        if (p.junction !== undefined) {
          ends.push(p.junction);
          continue;
        }
        const existing = junctionAt(ctx, level, p.point);
        if (existing !== undefined) {
          ends.push(existing);
          continue;
        }
        const jid = ctx.wc.mint('junctions');
        emit({ op: 'addJunction', id: jid, level, position: pt(p.point, `${base}/${m}`) }, `${base}/${m}`);
        ends.push(jid);
      }
      if (op.op === 'drawSeparator') {
        emit({ op: 'addSeparator', id: op.id ?? ctx.wc.mint('separators'), level, start: ends[0]!, end: ends[1]! });
      } else {
        const w: JsonObject = { op: 'addWall', id: op.id ?? ctx.wc.mint('walls'), level, start: ends[0]!, end: ends[1]! };
        for (const k of WALL_MEMBER_NAMES) if (has(k)) setMember(w, k, resolveContent('walls', [k], o[k], `${base}/${k}`, ctx));
        emit(w as unknown as ResolvedPrimitive);
      }
      break;
    }

    // ── 4.2 moveWall ──
    case 'moveWall': {
      const wall = resolveElement(op.wall, `${base}/wall`, ctx, EDGE);
      let by = resolveLength(op.by, `${base}/by`);
      const g = edgeGeometry(ctx, wall, `${base}/wall`);
      if (g.m === 0n) fail('FS-OPS-008', `${wall} has no length, so it has no direction to move across`, [wall], `${base}/wall`);
      if (op.toward !== undefined) {
        const room = resolveElement(op.toward, `${base}/toward`, ctx, ROOM);
        const rf = roomFace(ctx, room, `${base}/toward`);
        const { left, right } = sidesOf(ctx, rf.faces, wall, `${base}/wall`);
        const mag = by < 0n ? -by : by;
        if (left === rf.face && right !== rf.face) by = mag;
        else if (right === rf.face && left !== rf.face) by = -mag;
        else fail('FS-OPS-008', `${room} is not on one side of ${wall}, so there is no way to move it toward ${room}`, [wall], `${base}/toward`);
      }
      // by × the unit left normal (−dy, dx)/|d|, each coordinate rounded once (4.2).
      const k = Surd.sqrt(g.m).mulInt(by).divInt(g.m);
      const disp: IPoint = [k.mulInt(-g.d[1]).round(), k.mulInt(g.d[0]).round()];
      const e = ctx.wc.element(wall);
      const start = getMember(e, 'start') as string;
      const end = getMember(e, 'end') as string;
      const S = g.S;
      const E = g.E;
      emit({ op: 'moveJunction', id: start, to: pt([S[0] + disp[0], S[1] + disp[1]], `${base}/by`) }, `${base}/wall`);
      emit({ op: 'moveJunction', id: end, to: pt([E[0] + disp[0], E[1] + disp[1]], `${base}/by`) }, `${base}/wall`);
      break;
    }

    // ── 4.3 moveRoom ──
    case 'moveRoom': {
      const room = resolveElement(op.room, `${base}/room`, ctx, ROOM);
      const by = resolveVector(op.by, `${base}/by`);
      const rf = roomFace(ctx, room, `${base}/room`);
      const anchor = asPoint(getMember(ctx.wc.element(room), 'anchor'))!;
      const plan = sortIds(rf.faces.faces[rf.face]!.outer.vertices).map((j) => ({ j, p: rf.faces.positions.get(j)! }));
      for (const { j, p } of plan) emit({ op: 'moveJunction', id: j, to: pt([p[0] + by[0], p[1] + by[1]], `${base}/by`) }, `${base}/room`);
      emit({ op: 'setProperty', id: room, path: '/anchor', value: pt([anchor[0] + by[0], anchor[1] + by[1]], `${base}/by`) }, `${base}/room`);
      break;
    }

    // ── 4.4 resizeRoom ──
    case 'resizeRoom':
      resizeRoom(ctx, op.room, op.side, op.by, base, emit);
      break;

    // ── 4.5 addOpening, moveOpening ──
    case 'addOpening': {
      const wall = resolveElement(op.wall, `${base}/wall`, ctx, WALL);
      const g = edgeGeometry(ctx, wall, `${base}/wall`);
      const lengths: Partial<Record<'width' | 'height' | 'sill', number>> = {};
      for (const m of ['width', 'height', 'sill'] as const) if (has(m)) lengths[m] = toJsonInt(resolveLength(o[m], `${base}/${m}`), `${base}/${m}`);
      const w = lengths.width ?? fillWidth(ctx, op.fill);
      if (w === undefined)
        fail('FS-OPS-003', `the opening's width resolves from neither its own width nor its fill${op.fill === undefined ? '' : ` ${op.fill}`}`, [], has('fill') ? `${base}/fill` : base);
      const offset = resolvePosition(op.at, `${base}/at`, g.m, BigInt(w));
      const element: JsonObject = { wall, offset: toJsonInt(offset, `${base}/at`) };
      for (const m of ['fill', 'width', 'height', 'sill', 'hinge', 'swing', 'name'] as const)
        if (has(m)) setMember(element, m, m === 'width' || m === 'height' || m === 'sill' ? lengths[m] : o[m]);
      emit({ op: 'addElement', collection: 'openings', id: op.id ?? ctx.wc.mint('openings'), element });
      break;
    }
    case 'moveOpening': {
      const opening = resolveElement(op.opening, `${base}/opening`, ctx, OPENING);
      const e = ctx.wc.element(opening);
      const wall = getMember(e, 'wall');
      if (typeof wall !== 'string' || !ctx.wc.elementIn('walls', wall)) return fail('FS-OPS-003', `${opening} is on no wall`, [], `${base}/opening`);
      const g = edgeGeometry(ctx, wall, `${base}/opening`);
      const own = getMember(e, 'width');
      const w = typeof own === 'number' && Number.isSafeInteger(own) ? own : fillWidth(ctx, getMember(e, 'fill'));
      if (w === undefined) fail('FS-OPS-003', `the width of ${opening} resolves from neither its own width nor its fill`, [], `${base}/opening`);
      const offset = resolvePosition(op.at, `${base}/at`, g.m, BigInt(w));
      emit({ op: 'setProperty', id: opening, path: '/offset', value: toJsonInt(offset, `${base}/at`) }, `${base}/opening`);
      break;
    }

    // ── 4.6 addRoom, setRoomFinish ──
    case 'addRoom': {
      const level = resolveElement(op.level, `${base}/level`, ctx, LEVEL);
      const at = resolvePoint(op.at, `${base}/at`, ctx).point;
      const element: JsonObject = { level, anchor: pt(at, `${base}/at`) };
      for (const m of ['name', 'function', 'wallFinish', 'floorFinish', 'ceilingFinish'] as const)
        if (has(m)) setMember(element, m, resolveContent('rooms', [m], o[m], `${base}/${m}`, ctx));
      emit({ op: 'addElement', collection: 'rooms', id: op.id ?? ctx.wc.mint('rooms'), element });
      break;
    }
    case 'setRoomFinish': {
      const room = resolveElement(op.room, `${base}/room`, ctx, ROOM);
      const material = resolveContent('rooms', [`${op.surface}Finish`], op.material, `${base}/material`, ctx);
      emit({ op: 'setProperty', id: room, path: `/${op.surface}Finish`, value: material }, `${base}/room`);
      break;
    }

    // ── 4.7 removeWall ──
    case 'removeWall': {
      const wall = resolveElement(op.wall, `${base}/wall`, ctx, WALL);
      const keep = op.keep === undefined ? undefined : resolveElement(op.keep, `${base}/keep`, ctx, ROOM);
      const level = getMember(ctx.wc.element(wall), 'level');
      if (typeof level !== 'string') return fail('FS-OPS-007', `${wall} is on no level, so it has no faces either side`, [], `${base}/wall`);
      const faces = ctx.faces.get(level);
      if (faces.broken !== undefined) return fail('FS-OPS-007', `level ${level} has no faces to read: ${faces.broken}`, [level], `${base}/wall`);
      const { left, right } = sidesOf(ctx, faces, wall, `${base}/wall`);
      const roomsL = left >= 0 ? faces.roomsIn(ctx.wc, left) : [];
      const roomsR = right >= 0 ? faces.roomsIn(ctx.wc, right) : [];
      if (left !== right && roomsL.length > 0 && roomsR.length > 0) {
        if (keep === undefined || (!roomsL.includes(keep) && !roomsR.includes(keep)))
          fail('FS-OPS-008', `${wall} has ${roomsL.join(', ')} on one side and ${roomsR.join(', ')} on the other: say which to keep`, [wall], has('keep') ? `${base}/keep` : base);
        for (const r of roomsL.includes(keep) ? roomsR : roomsL) emit({ op: 'removeElement', id: r }, `${base}/keep`);
      }
      emit({ op: 'removeElement', id: wall, cascade: true }, `${base}/wall`);
      break;
    }
  }
  return out;
}

/** A junction on `level` at exactly `p` (4.1), the first by ID if (mid-batch) there are several. */
function junctionAt(ctx: Ctx, level: string, p: IPoint): string | undefined {
  for (const id of ctx.wc.ids('junctions')) {
    const j = ctx.wc.elementIn('junctions', id);
    if (getMember(j, 'level') !== level) continue;
    const q = asPoint(getMember(j, 'position'));
    if (q && q[0] === p[0] && q[1] === p[1]) return id;
  }
  return undefined;
}

/** The faces on an edge's left (as it runs start → end) and right, −1 for the unbounded face. */
function sidesOf(ctx: Ctx, faces: LevelFaces, edge: string, ptr: string): { left: number; right: number } {
  if (faces.broken !== undefined) return fail('FS-OPS-007', `level ${faces.level} has no faces to read: ${faces.broken}`, [faces.level], ptr);
  const i = faces.edgeIndex(edge);
  if (i < 0) return fail('FS-OPS-007', `${edge} is not an edge of level ${faces.level}`, [faces.level], ptr);
  return { left: faces.faceLeftOf(2 * i), right: faces.faceLeftOf(2 * i + 1) };
}

/** The width of a door or window type, when `fill` names one that has a width. */
function fillWidth(ctx: Ctx, fill: unknown): number | undefined {
  if (typeof fill !== 'string') return undefined;
  const t = ctx.wc.elementIn('types', fill);
  const kind = getMember(t, 'kind');
  const w = getMember(t, 'width');
  return (kind === 'doorType' || kind === 'windowType') && typeof w === 'number' && Number.isSafeInteger(w) ? w : undefined;
}

/** 4.4 resizeRoom. */
function resizeRoom(ctx: Ctx, roomRef: string, side: Side, byRef: unknown, base: string, emit: (p: ResolvedPrimitive, idPtr?: string) => void): void {
  const room = resolveElement(roomRef, `${base}/room`, ctx, ROOM);
  const by = resolveLength(byRef, `${base}/by`);
  const rf = roomFace(ctx, room, `${base}/room`);
  const { faces, level } = rf;
  const g = faces.graph!;
  const hs = faces.faces[rf.face]!.outer.halfEdges;
  const n = hs.length;
  const u = SIDE_UNIT[side];
  const isSide = (h: number): boolean => {
    const nv = faces.outwardNormal(h);
    return predicates.cross(nv, u) === 0n && predicates.dot(nv, u) > 0n;
  };
  const inSide = hs.map(isSide);
  const count = inSide.filter(Boolean).length;
  const not = (why: string): never => fail('FS-OPS-008', `the ${side} side of ${room} ${why}: resize it wall by wall`, [room], `${base}/side`);
  if (count === 0) not('is missing or oblique: no edge faces exactly ' + side);
  // Consecutive along the cycle: exactly one index starts a block.
  const starts = hs.map((_, i) => i).filter((i) => inSide[i] && !inSide[(i - 1 + n) % n]);
  if (starts.length !== 1) not('is jogged: its edges are not consecutive');
  const s = starts[0]!;
  const run = Array.from({ length: count }, (_, i) => hs[(s + i) % n]!);
  // On one line: every run junction has the same coordinate along u.
  const pos = (j: string): IPoint => faces.positions.get(j)!;
  const coord = (p: IPoint): bigint => p[0] * u[0] + p[1] * u[1];
  const P = [g.origin(run[0]!), ...run.map((h) => g.dest(h))];
  if (P.some((j) => coord(pos(j)) !== coord(pos(P[0]!)))) not('is jogged: its edges do not lie on one line');
  const t = g.direction(run[0]!);
  const v: IPoint = [by * u[0], by * u[1]];
  /** Does another edge leave junction j along the run's line, in direction `dir`? */
  const continues = (j: string, dir: IPoint): boolean =>
    (g.stars.get(j) ?? []).some((h) => {
      const d = g.direction(h);
      return predicates.cross(d, dir) === 0n && predicates.dot(d, dir) > 0n;
    });
  const P0 = P[0]!;
  const Pk = P[P.length - 1]!;
  const cont0 = continues(P0, [-t[0], -t[1]]);
  const contK = continues(Pk, t);
  const ptr = `${base}/room`;

  // 1. Each continuing end, P₀ first: a new junction, the run edge reconnected, a jog.
  for (const [end, h, isCont] of [
    [P0, run[0]!, cont0],
    [Pk, run[run.length - 1]!, contK],
  ] as const) {
    if (!isCont) continue;
    const edge = faces.edges[h >> 1]!;
    const el = ctx.wc.element(edge.id);
    const p = pos(end);
    const jid = ctx.wc.mint('junctions');
    emit({ op: 'addJunction', id: jid, level, position: pt([p[0] + v[0], p[1] + v[1]], `${base}/by`) }, ptr);
    emit({ op: 'setProperty', id: edge.id, path: getMember(el, 'start') === end ? '/start' : '/end', value: jid }, ptr);
    if (edge.kind === 'walls') {
      const w: JsonObject = { op: 'addWall', id: ctx.wc.mint('walls'), level, start: end, end: jid };
      for (const k of ['type', 'layers', 'justification'] as const) {
        const val = getMember(el, k);
        if (val !== undefined) setMember(w, k, val);
      }
      emit(w as unknown as ResolvedPrimitive, ptr);
    } else emit({ op: 'addSeparator', id: ctx.wc.mint('separators'), level, start: end, end: jid }, ptr);
  }
  // 2. Every run junction that is not a continuing end moves by v, by ID.
  const moving = sortIds(P.filter((j) => !((j === P0 && cont0) || (j === Pk && contK))));
  for (const j of moving) {
    const p = pos(j);
    emit({ op: 'moveJunction', id: j, to: pt([p[0] + v[0], p[1] + v[1]], `${base}/by`) }, ptr);
  }
  // 3. Anchors move by v/2: the room's, then each room's across a side edge, by ID. Each new
  //    coordinate is the exact anchor + v/2, rounded once, ties to even.
  const moved = (a: IPoint): IPoint => [roundHalfEvenRational(2n * a[0] + v[0], 2n), roundHalfEvenRational(2n * a[1] + v[1], 2n)];
  const across = sortIds(
    run.flatMap((h) => {
      const f = faces.faceLeftOf(h ^ 1);
      return f >= 0 && f !== rf.face ? faces.roomsIn(ctx.wc, f) : [];
    }),
  ).filter((r) => r !== room);
  for (const r of [room, ...across]) {
    const a = asPoint(getMember(ctx.wc.element(r), 'anchor'));
    if (!a) continue;
    emit({ op: 'setProperty', id: r, path: '/anchor', value: pt(moved(a), `${base}/by`) }, ptr);
  }
}

export { isObject };
