/**
 * Steps 2–4 of the transaction (1.2), one operation at a time: resolve the operation's references
 * against the working copy as it stands, expand a composite into the exact primitives chapter 4
 * defines, and apply them. Returns the resolved primitives, for the echo (1.4).
 */
import { predicates, roundHalfEvenRational, Surd } from '@floorspec/engine';
import { fail } from './diagnostics.js';
import { asPoint, editDesign, SIDE_UNIT, type LevelFaces } from './model/faces.js';
import { EXTENSION_PREFIX, ITEMS, RESERVED_TARGETS, type CollectionName, type ReservedTarget } from './model/working.js';
import { applyPrimitive } from './primitives.js';
import {
  ANY,
  BUILDING,
  JUNCTION,
  edgeGeometry,
  EXTENSION_ELEMENT,
  LEVEL,
  OPENING,
  resolveArea,
  resolveElement,
  resolveItem,
  resolveLength,
  resolvePoint,
  resolvePosition,
  resolveRoom,
  resolveVector,
  roomFace,
  sideToward,
  toJsonInt,
  WALL,
  type Ctx,
  type IPoint,
} from './references/resolve.js';
import type { HostRef, Operation, Point, ResolvedPrimitive, Side } from './types.js';
import { clone, cmpStr, getMember, isObject, setMember, type JsonObject } from './lib/json.js';

const pt = (p: IPoint, ptr: string): Point => [toJsonInt(p[0], ptr), toJsonInt(p[1], ptr)];
const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(cmpStr);

/** The members drawWall carries to the wall as given (4.1), in Core §5.2's order. */
const WALL_MEMBER_NAMES = ['type', 'layers', 'justification', 'base', 'top', 'name', 'extensions', 'extras'] as const;
/** The members every created element may carry (2.1). */
const COMMON_MEMBERS = ['name', 'extensions', 'extras'] as const;

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
      // 2.5: never resolved inside `element` — it is added exactly as given.
      if (op.extension !== undefined) {
        const id = op.id ?? ctx.wc.mint({ prefix: EXTENSION_PREFIX });
        emit({ op: 'addElement', extension: op.extension, collection: op.collection, id, element: op.element });
      } else {
        const id = op.id ?? ctx.wc.mint(op.collection as CollectionName | typeof ITEMS);
        emit({ op: 'addElement', collection: op.collection, id, element: op.element });
      }
      break;
    }
    case 'addJunction':
    case 'addWall':
    case 'addSeparator': {
      // 2.1.2: the shorthand's references are resolved first — level, then position or start and
      // end — and it is then exactly the addElement of the resolved values; every other member is
      // passed as given.
      const collection: CollectionName = op.op === 'addJunction' ? 'junctions' : op.op === 'addWall' ? 'walls' : 'separators';
      const resolvedRefs: JsonObject = { level: resolveElement(op.level, `${base}/level`, ctx, LEVEL) };
      if (op.op === 'addJunction') resolvedRefs.position = pt(resolvePoint(op.position, `${base}/position`, ctx).point, `${base}/position`);
      else {
        resolvedRefs.start = resolveElement(op.start, `${base}/start`, ctx, JUNCTION);
        resolvedRefs.end = resolveElement(op.end, `${base}/end`, ctx, JUNCTION);
      }
      const id = op.id ?? ctx.wc.mint(collection);
      const p: JsonObject = { op: op.op, id };
      for (const k of Object.keys(o)) if (k !== 'op' && k !== 'id') setMember(p, k, Object.hasOwn(resolvedRefs, k) ? resolvedRefs[k] : o[k]);
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
      // 2.5: never resolved inside `value` — it is set exactly as given.
      else emit({ op: 'setProperty', id, path: op.path, value: op.value });
      break;
    }
    case 'moveJunction': {
      const id = resolveElement(op.id, `${base}/id`, ctx, JUNCTION);
      const to = resolvePoint(op.to, `${base}/to`, ctx).point;
      emit({ op: 'moveJunction', id, to: pt(to, `${base}/to`) });
      break;
    }
    // 2.6 (Ops 0.2): `a` and `b` are program items, resolved in that order.
    case 'setAdjacency':
    case 'removeAdjacency': {
      const a = resolveItem(op.a, `${base}/a`, ctx);
      const b = resolveItem(op.b, `${base}/b`, ctx);
      if (op.op === 'removeAdjacency') emit({ op: 'removeAdjacency', a, b, kind: op.kind });
      else emit({ op: 'setAdjacency', a, b, kind: op.kind, ...(has('weight') && { weight: op.weight }) });
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
        const sep: JsonObject = { op: 'addSeparator', id: op.id ?? ctx.wc.mint('separators'), level, start: ends[0]!, end: ends[1]! };
        for (const k of COMMON_MEMBERS) if (has(k)) setMember(sep, k, o[k]);
        emit(sep as unknown as ResolvedPrimitive);
      } else {
        const w: JsonObject = { op: 'addWall', id: op.id ?? ctx.wc.mint('walls'), level, start: ends[0]!, end: ends[1]! };
        for (const k of WALL_MEMBER_NAMES) if (has(k)) setMember(w, k, o[k]);
        emit(w as unknown as ResolvedPrimitive);
      }
      break;
    }

    // ── 4.2 moveWall ──
    case 'moveWall': {
      const wall = resolveElement(op.wall, `${base}/wall`, ctx, WALL);
      let by = resolveLength(op.by, `${base}/by`);
      const g = edgeGeometry(ctx, wall, `${base}/wall`);
      if (op.toward !== undefined) {
        const room = resolveRoom(op.toward, `${base}/toward`, ctx);
        const side = sideToward(ctx, wall, room, `${base}/toward`);
        const mag = by < 0n ? -by : by;
        if (side === 'left') by = mag;
        else if (side === 'right') by = -mag;
        else fail('FS-OPS-008', `${room} is not on one side of ${wall}, so there is no way to move it toward ${room}`, [wall], `${base}/toward`);
      }
      if (g.m === 0n) fail('FS-OPS-008', `${wall} has no length, so it has no direction to move across`, [wall], `${base}/wall`);
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
      const room = resolveRoom(op.room, `${base}/room`, ctx);
      const by = resolveVector(op.by, `${base}/by`);
      const rf = roomFace(ctx, room, `${base}/room`);
      const anchor = asPoint(getMember(ctx.wc.element(room), 'anchor'))!;
      const plan = sortIds(rf.faces.faces[rf.face]!.outer.vertices).map((j) => ({ j, p: rf.faces.positions.get(j)! }));
      // What stands on the room's floor or hangs from its ceiling (Ops 0.2), found before anything moves.
      const onSurface = onSurfaceOf(ctx, room, true);
      for (const { j, p } of plan) emit({ op: 'moveJunction', id: j, to: pt([p[0] + by[0], p[1] + by[1]], `${base}/by`) }, `${base}/room`);
      emit({ op: 'setProperty', id: room, path: '/anchor', value: pt([anchor[0] + by[0], anchor[1] + by[1]], `${base}/by`) }, `${base}/room`);
      // Step 3 (Ops 0.3, FS-OPS-4.3.2): a vaulted ceiling's ridge is a plan point, and moves with its
      // room; nothing else of the ceiling or the floor changes. A 0.2 or 0.1 document has no vault.
      const ceiling = getMember(ctx.wc.element(room), 'ceiling');
      if (getMember(ceiling, 'kind') === 'vaulted') {
        const ridge = getMember(ceiling, 'ridge');
        const a = Array.isArray(ridge) && ridge.length === 2 ? asPoint(ridge[0]) : undefined;
        const b = Array.isArray(ridge) && ridge.length === 2 ? asPoint(ridge[1]) : undefined;
        if (a && b)
          emit(
            { op: 'setProperty', id: room, path: '/ceiling/ridge', value: [pt([a[0] + by[0], a[1] + by[1]], `${base}/by`), pt([b[0] + by[0], b[1] + by[1]], `${base}/by`)] },
            `${base}/room`,
          );
      }
      for (const id of onSurface) {
        const p = asPoint(getMember(getMember(ctx.wc.element(id), 'host'), 'position'))!;
        emit({ op: 'setProperty', id, path: '/host/position', value: pt([p[0] + by[0], p[1] + by[1]], `${base}/by`) }, `${base}/room`);
      }
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
      for (const m of ['fill', 'width', 'height', 'sill', 'hinge', 'swing', 'name', 'extensions', 'extras'] as const)
        if (has(m)) setMember(element, m, m === 'width' || m === 'height' || m === 'sill' ? lengths[m] : o[m]);
      emit({ op: 'addElement', collection: 'openings', id: op.id ?? ctx.wc.mint('openings'), element });
      break;
    }
    case 'moveOpening': {
      const opening = resolveElement(op.opening, `${base}/opening`, ctx, OPENING);
      const e = ctx.wc.element(opening);
      const wall = getMember(e, 'wall');
      if (typeof wall !== 'string' || !ctx.wc.elementIn('walls', wall)) return fail('FS-OPS-003', `${opening} is on no wall`, [opening], `${base}/opening`);
      if (op.at !== undefined) {
        // 4.5.1: absolute — `at` is a position, resolved with the opening's effective width.
        const g = edgeGeometry(ctx, wall, `${base}/opening`);
        const own = getMember(e, 'width');
        const w = typeof own === 'number' && Number.isSafeInteger(own) ? own : fillWidth(ctx, getMember(e, 'fill'));
        if (w === undefined) fail('FS-OPS-003', `the width of ${opening} resolves from neither its own width nor its fill`, [opening], `${base}/opening`);
        const offset = resolvePosition(op.at, `${base}/at`, g.m, BigInt(w));
        emit({ op: 'setProperty', id: opening, path: '/offset', value: toJsonInt(offset, `${base}/at`) }, `${base}/opening`);
        break;
      }
      // 4.5.2: relative — the offset in the working copy plus `by`, its sign chosen by `toward`.
      const old = getMember(e, 'offset');
      if (typeof old !== 'number' || !Number.isSafeInteger(old)) return fail('FS-OPS-003', `${opening} has no integer offset to move it from`, [opening], `${base}/opening`);
      let by = resolveLength(op.by, `${base}/by`);
      const mag = by < 0n ? -by : by;
      if (op.toward === 'end') by = mag;
      else if (op.toward === 'start') by = -mag;
      else if (op.toward !== undefined) {
        const g = edgeGeometry(ctx, wall, `${base}/opening`);
        const u = SIDE_UNIT[op.toward];
        const dot = g.d[0] * u[0] + g.d[1] * u[1];
        if (dot === 0n) fail('FS-OPS-008', `${wall} runs perpendicular to ${op.toward}, so ${opening} cannot move along it toward ${op.toward}`, [wall], `${base}/toward`);
        by = dot > 0n ? mag : -mag;
      }
      emit({ op: 'setProperty', id: opening, path: '/offset', value: toJsonInt(BigInt(old) + by, `${base}/by`) }, `${base}/opening`);
      break;
    }

    // ── 4.6 addRoom, setRoomFinish ──
    case 'addRoom': {
      const level = resolveElement(op.level, `${base}/level`, ctx, LEVEL);
      const at = resolvePoint(op.at, `${base}/at`, ctx).point;
      const element: JsonObject = { level, anchor: pt(at, `${base}/at`) };
      // Ops 0.2: the program item the room fulfils, resolved after `level` and `at`.
      if (op.brief !== undefined) setMember(element, 'brief', resolveItem(op.brief, `${base}/brief`, ctx));
      for (const m of ['name', 'function', 'wallFinish', 'floorFinish', 'ceilingFinish', 'extensions', 'extras'] as const) if (has(m)) setMember(element, m, o[m]);
      emit({ op: 'addElement', collection: 'rooms', id: op.id ?? ctx.wc.mint('rooms'), element });
      break;
    }
    case 'setRoomFinish': {
      const room = resolveRoom(op.room, `${base}/room`, ctx);
      emit({ op: 'setProperty', id: room, path: `/${op.surface}Finish`, value: op.material }, `${base}/room`);
      break;
    }
    // 4.6.2 (Ops 0.2)
    case 'setRoomBrief': {
      const room = resolveRoom(op.room, `${base}/room`, ctx);
      const item = resolveItem(op.item, `${base}/item`, ctx);
      emit({ op: 'setProperty', id: room, path: '/brief', value: item }, `${base}/room`);
      break;
    }

    // ── 4.7 removeWall ──
    case 'removeWall': {
      const wall = resolveElement(op.wall, `${base}/wall`, ctx, WALL);
      const keep = op.keep === undefined ? undefined : resolveRoom(op.keep, `${base}/keep`, ctx);
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
        for (const r of roomsL.includes(keep) ? roomsR : roomsL) {
          // Ops 0.2: what stood in the room not kept now stands in the one kept.
          for (const id of onSurfaceOf(ctx, r, false)) emit({ op: 'setProperty', id, path: '/host/room', value: keep }, `${base}/keep`);
          emit({ op: 'removeElement', id: r }, `${base}/keep`);
        }
      }
      emit({ op: 'removeElement', id: wall, cascade: true }, `${base}/wall`);
      break;
    }

    // ── 4.8 addLevel ──
    case 'addLevel': {
      // References in the order 4.8 lists them: building, height, then elevation, above or below.
      const building = resolveElement(op.building, `${base}/building`, ctx, BUILDING);
      const height = resolveLength(op.height, `${base}/height`);
      let elevation: bigint;
      if (op.elevation !== undefined) elevation = resolveLength(op.elevation, `${base}/elevation`);
      else {
        const m = op.above !== undefined ? 'above' : 'below';
        const level = resolveElement((op.above ?? op.below)!, `${base}/${m}`, ctx, LEVEL);
        const l = ctx.wc.element(level);
        const le = getMember(l, 'elevation');
        const lh = getMember(l, 'height');
        if (typeof le !== 'number' || !Number.isSafeInteger(le) || typeof lh !== 'number' || !Number.isSafeInteger(lh))
          return fail('FS-OPS-003', `${level} has no integer elevation and height to place a level ${m} it`, [level], `${base}/${m}`);
        elevation = m === 'above' ? BigInt(le) + BigInt(lh) : BigInt(le) - height;
      }
      const element: JsonObject = {
        building,
        elevation: toJsonInt(elevation, op.elevation !== undefined ? `${base}/elevation` : `${base}/height`),
        height: toJsonInt(height, `${base}/height`),
      };
      for (const m of COMMON_MEMBERS) if (has(m)) setMember(element, m, o[m]);
      emit({ op: 'addElement', collection: 'levels', id: op.id ?? ctx.wc.mint('levels'), element });
      break;
    }

    // ── 4.9 addProgramItem (Ops 0.2) ──
    case 'addProgramItem': {
      // References in the order 4.9 lists them: targetArea, minArea, level.
      const element: JsonObject = { function: op.function };
      if (has('count')) setMember(element, 'count', op.count);
      for (const m of ['targetArea', 'minArea'] as const) if (has(m)) setMember(element, m, resolveArea(o[m], `${base}/${m}`));
      if (op.level !== undefined) setMember(element, 'level', resolveElement(op.level, `${base}/level`, ctx, LEVEL));
      for (const m of COMMON_MEMBERS) if (has(m)) setMember(element, m, o[m]);
      emit({ op: 'addElement', collection: ITEMS, id: op.id ?? ctx.wc.mint(ITEMS), element });
      break;
    }

    // ── 4.10 placeElement and moveElement (Ops 0.2) ──
    case 'placeElement': {
      const { host, level } = resolveHost(ctx, op.host, `${base}/host`);
      const element = clone(op.element) as JsonObject;
      setMember(element, 'host', host);
      const fallback = getMember(element, 'fallback');
      if (!Object.hasOwn(element, 'fallback')) setMember(element, 'fallback', { level });
      else if (isObject(fallback)) setMember(fallback, 'level', level);
      emit({ op: 'addElement', extension: op.extension, collection: op.collection, id: op.id ?? ctx.wc.mint({ prefix: EXTENSION_PREFIX }), element });
      break;
    }
    case 'moveElement': {
      const id = resolveElement(op.element, `${base}/element`, ctx, EXTENSION_ELEMENT);
      const { host, level } = resolveHost(ctx, op.host, `${base}/host`);
      emit({ op: 'setProperty', id, path: '/host', value: host }, `${base}/element`);
      emit({ op: 'setProperty', id, path: '/fallback/level', value: level }, `${base}/element`);
      break;
    }
  }
  return out;
}

/**
 * Ops 0.2: the extension elements on a room's floor or ceiling — a `surface` host on the room — by
 * ID; with `pointOnly`, only those whose position is an integer point (4.3).
 */
function onSurfaceOf(ctx: Ctx, room: string, pointOnly: boolean): string[] {
  return ctx.wc
    .extElements()
    .filter((x) => {
      const h = getMember(x.element, 'host');
      return isObject(h) && getMember(h, 'mode') === 'surface' && getMember(h, 'room') === room && (!pointOnly || asPoint(getMember(h, 'position')) !== undefined);
    })
    .map((x) => x.id);
}

/** 4.10: a host reference resolved to a Core host (Core §13.3), and the host's level. */
function resolveHost(ctx: Ctx, h: HostRef, ptr: string): { host: JsonObject; level: string } {
  let host: JsonObject;
  let owner: { kind: 'walls' | 'rooms'; id: string; member: string } | undefined;
  if (h.mode === 'wallFace') {
    const wall = resolveElement(h.wall, `${ptr}/wall`, ctx, WALL);
    const g = edgeGeometry(ctx, wall, `${ptr}/wall`);
    let side: 'left' | 'right';
    if (h.side !== undefined) side = h.side;
    else {
      const room = resolveRoom(h.toward, `${ptr}/toward`, ctx);
      const s = sideToward(ctx, wall, room, `${ptr}/toward`);
      if (s === undefined) return fail('FS-OPS-008', `${room} is not on one side of ${wall}, so neither face of it looks into ${room}`, [wall], `${ptr}/toward`);
      side = s;
    }
    // A hosted element is placed by a point: its position is resolved with w = 0 (3.5).
    const offset = resolvePosition(h.at, `${ptr}/at`, g.m, 0n);
    const height = resolveLength(h.height, `${ptr}/height`);
    host = { mode: 'wallFace', wall, side, offset: toJsonInt(offset, `${ptr}/at`), height: toJsonInt(height, `${ptr}/height`) };
    owner = { kind: 'walls', id: wall, member: 'wall' };
  } else if (h.mode === 'surface') {
    const room = resolveRoom(h.room, `${ptr}/room`, ctx);
    const at = resolvePoint(h.at, `${ptr}/at`, ctx).point;
    host = { mode: 'surface', room, surface: h.surface, position: pt(at, `${ptr}/at`) };
    owner = { kind: 'rooms', id: room, member: 'room' };
  } else {
    const level = resolveElement(h.level, `${ptr}/level`, ctx, LEVEL);
    const at = resolvePoint(h.at, `${ptr}/at`, ctx).point;
    host = { mode: 'free', level, position: pt(at, `${ptr}/at`) };
  }
  if (Object.hasOwn(h, 'rotation')) setMember(host, 'rotation', clone((h as { rotation?: unknown }).rotation));
  if (owner === undefined) return { host, level: host.level as string };
  const level = getMember(ctx.wc.elementIn(owner.kind, owner.id), 'level');
  if (typeof level !== 'string') return fail('FS-OPS-003', `${owner.id} is on no level, so the element placed on it has none`, [owner.id], `${ptr}/${owner.member}`);
  return { host, level };
}

/** A junction on `level` at exactly `p` (4.1), the first by ID if (mid-batch) there are several. */
function junctionAt(ctx: Ctx, level: string, p: IPoint): string | undefined {
  const keep = editDesign(ctx.wc); // Ops 0.3, 2.8.2: the junctions of the edit design
  for (const id of ctx.wc.ids('junctions')) {
    const j = ctx.wc.elementIn('junctions', id);
    if (getMember(j, 'level') !== level || (j && keep && !keep(j))) continue;
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
  const room = resolveRoom(roomRef, `${base}/room`, ctx);
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
  // Continuing ends where an edge leaves exactly in the direction of v; it must be longer than |v|.
  const alongV = new Set<string>();
  if (by !== 0n)
    for (const [end, isCont] of [
      [P0, cont0],
      [Pk, contK],
    ] as const) {
      if (!isCont) continue;
      for (const h of g.stars.get(end) ?? []) {
        const d = g.direction(h);
        if (predicates.cross(d, v) !== 0n || predicates.dot(d, v) <= 0n) continue;
        alongV.add(end);
        if (predicates.dot(d, d) <= by * by) not(`cannot move ${by < 0n ? -by : by} base units past ${end}: the edge leaving it that way is not longer than that`);
      }
    }

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
    // At a T — an edge already leaving the end in the direction of v — no jog is added: the new
    // junction lies on that edge, and normalization splits it there (4.4).
    if (alongV.has(end)) continue;
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

