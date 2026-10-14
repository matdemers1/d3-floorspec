import { kindOf, type EditorModel, type LevelView, type Point, type WallView } from '../model';
import { dist, faceAt, project } from '../geometry';
import { moveDevice, type HostRef } from '../systems/ops';
import type { DeviceView } from '../systems/view';
import type { Batch } from '../ops';
import { boundsOfIds, type Rect } from './shapes';
import { cornersOf, wallsOfRoom } from './rooms';
import { ridersOf } from './riders';

/**
 * Moving, turning and mirroring many elements as one batch (FLR-T-18.8). Every edit here is a
 * composition of the Ops the editor already sends one element at a time — moveJunction, moveOpening,
 * moveElement, setProperty — gathered into a single batch, so the whole gesture is one transaction
 * and one undo step, and the server judges it as it judges any other.
 *
 * A transform maps plan points (`map`), turns what has a facing (`turn`, microdegrees) and may be a
 * reflection (`flip`). Each element follows it its own way:
 *
 * - walls and separators move by their junctions, once each however many of them share one; a wall
 *   whose two ends both move is carried rigidly, and under a reflection its start and end are swapped
 *   so its exterior stays outside (Core 5.4 puts the exterior on the left of start → end) — its
 *   openings and wall-face devices measured from the other end to match;
 * - an opening on a wall that stays slides along it to where the transform takes its middle;
 * - a device on a wall face that stays slides along that face the same way; one on a floor, a ceiling
 *   or standing free moves its host's position and turns, changing room if the point lands in another;
 * - a room moves its anchor (and a vaulted ceiling's ridge) — and is carried along when every corner
 *   of its face moves, so a room's walls never leave its anchor behind;
 * - a slab's outline, a roof's footprint and a stair's position and direction are set.
 *
 * Elements with nothing that moves them — a hostless landscape bed, a level, a type — are reported
 * back, not silently dropped.
 */

export interface Xform {
  map: (p: Point) => Point;
  /** Microdegrees added to every facing. */
  turn: number;
  /** A reflection: across a vertical line (`h`, left ↔ right) or a horizontal one (`v`, up ↔ down). */
  flip: 'h' | 'v' | null;
}

const r = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];

export const translation = (d: Point): Xform => ({ map: (p) => [p[0] + d[0], p[1] + d[1]], turn: 0, flip: null });

/** A quarter turn about a point: `+1` counter-clockwise (left), `-1` clockwise (right), `2` a half turn. Exact on integers. */
export function quarterTurn(c: Point, quarters: 1 | -1 | 2): Xform {
  const cx = Math.round(c[0]);
  const cy = Math.round(c[1]);
  const map = (p: Point): Point => {
    const x = p[0] - cx;
    const y = p[1] - cy;
    if (quarters === 1) return [cx - y, cy + x];
    if (quarters === -1) return [cx + y, cy - x];
    return [cx - x, cy - y];
  };
  return { map, turn: quarters * 90_000_000, flip: null };
}

/** A mirror about the selection's middle: `h` flips left ↔ right, `v` flips up ↔ down. */
export function mirror(c: Point, flip: 'h' | 'v'): Xform {
  // Twice the middle, rounded once: the mirror line may fall on a half unit, the images never do.
  const x2 = Math.round(2 * c[0]);
  const y2 = Math.round(2 * c[1]);
  return { map: (p) => (flip === 'h' ? [x2 - p[0], p[1]] : [p[0], y2 - p[1]]), turn: 0, flip };
}

/** An angle in (−180°, 180°], microdegrees (Core 2.4's angleHalfOpen). */
export function halfOpen(angle: number): number {
  const a = ((Math.round(angle) % 360_000_000) + 540_000_000) % 360_000_000 - 180_000_000;
  return a === -180_000_000 ? 180_000_000 : a;
}

/** Where a facing points after the transform. */
export function facingAfter(xf: Xform, angle: number): number {
  const reflected = xf.flip === 'h' ? 180_000_000 - angle : xf.flip === 'v' ? -angle : angle;
  return halfOpen(reflected + xf.turn);
}

export interface Transformed {
  batch: Batch;
  /** The elements the batch moves (as selected). */
  moved: string[];
  /** The selected elements it could not move, and why. */
  skipped: { id: string; why: string }[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asPoint = (v: unknown): Point | null => (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null);
const lengthOf = (w: WallView): number => w.arc?.length ?? dist(w.a, w.b);

export interface TransformOptions {
  /**
   * FLR-T-18.18: take what sits on the elements along (arrange/riders.ts) — a cooktop with its
   * island. On by default; `except` are left out of it (moved by some other part of the same edit).
   */
  carry?: boolean;
  except?: ReadonlySet<string>;
}

/** The batch that applies `xf` to the elements `ids` on `level` — and to what rides on them. */
export function transformBatch(model: EditorModel, level: LevelView, ids: readonly string[], xf: Xform, o: TransformOptions = {}): Transformed {
  const doc = model.document;
  const ops: Batch = [];
  const moved: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  const selected = new Set(ids);
  const riders = new Set(o.carry === false ? [] : ridersOf(level, ids, o.except));
  const junctions = new Set<string>();
  const wallsById = new Map(level.walls.map((w) => [w.id, w]));

  // 1. What moves the junctions: walls, separators, junctions themselves, and the corners of rooms.
  for (const id of ids) {
    const kind = kindOf(model, id);
    if (kind === 'junction' && level.junctions.some((j) => j.id === id)) junctions.add(id);
    else if (kind === 'wall' || kind === 'separator') {
      const w = wallsById.get(id) ?? level.separators.find((s) => s.id === id);
      if (w === undefined) continue;
      junctions.add(w.start);
      junctions.add(w.end);
    } else if (kind === 'room') {
      for (const j of cornersOf(level, id)) junctions.add(j);
    }
  }
  for (const j of level.junctions) {
    if (!junctions.has(j.id)) continue;
    const to = r(xf.map(j.position));
    if (to[0] !== j.position[0] || to[1] !== j.position[1]) ops.push({ op: 'moveJunction', id: j.id, to });
  }
  // A wall carried whole: both its ends move. Under a reflection it is turned round (start ↔ end).
  const rigid = new Set(level.walls.filter((w) => junctions.has(w.start) && junctions.has(w.end)).map((w) => w.id));
  const turnedRound = new Set(xf.flip === null ? [] : rigid);
  for (const id of turnedRound) {
    const w = wallsById.get(id) as WallView;
    ops.push({ op: 'setProperty', id, path: '/start', value: w.end }, { op: 'setProperty', id, path: '/end', value: w.start });
  }
  // Rooms carried along: every side's wall is carried whole (or the room itself is selected).
  const rigidOrMoving = (w: WallView) => junctions.has(w.start) && junctions.has(w.end);
  const carriedRooms = new Set(
    level.rooms
      .filter((room) => {
        if (selected.has(room.id)) return true;
        const sides = wallsOfRoom(level, room.id);
        return sides.length > 0 && sides.length === level.faces.find((f) => f.room === room.id)?.outer.length && sides.every((s) => rigidOrMoving(s.wall));
      })
      .map((room) => room.id),
  );

  // 2. Openings: on a wall turned round, measured from its other end; selected on a wall that stays, slid along it.
  for (const o of level.openings) {
    const wall = wallsById.get(o.wall);
    if (wall === undefined) continue;
    const element = doc.openings?.[o.id] as Json | undefined;
    const L = lengthOf(wall);
    if (turnedRound.has(wall.id)) {
      ops.push({ op: 'setProperty', id: o.id, path: '/offset', value: Math.max(0, Math.round(L - o.offset - o.width)) });
      const hinge = element?.['hinge'];
      if (o.kind === 'door' || hinge !== undefined) ops.push({ op: 'setProperty', id: o.id, path: '/hinge', value: o.hinge === 'end' ? 'start' : 'end' });
      if (selected.has(o.id)) moved.push(o.id);
      continue;
    }
    if (!selected.has(o.id)) continue;
    if (rigid.has(wall.id)) {
      moved.push(o.id);
      continue;
    }
    const mid: Point = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    const at = project(xf.map(mid), wall.a, wall.b);
    const offset = Math.max(0, Math.min(Math.round(L - o.width), Math.round(at.t * L - o.width / 2)));
    if (offset !== Math.round(o.offset)) ops.push({ op: 'moveOpening', opening: o.id, at: offset });
    moved.push(o.id);
  }

  // 3. Devices and furniture.
  for (const d of level.devices) {
    const host = d.host;
    const onTurnedWall = host?.['mode'] === 'wallFace' && turnedRound.has(String(host['wall']));
    // What stands in a room that is carried goes with it: its furniture, fixtures and ceiling lights.
    const inCarriedRoom = host?.['mode'] === 'surface' && carriedRooms.has(String(host['room']));
    if (!selected.has(d.id) && !riders.has(d.id) && !onTurnedWall && !inCarriedRoom) continue;
    const next = deviceHost(level, d, xf, { rigid, turnedRound, carriedRooms });
    if (next === 'none') {
      if (selected.has(d.id)) skipped.push({ id: d.id, why: 'it has no host to move' });
      continue;
    }
    if (next !== null) ops.push(...moveDevice(d.id, next));
    if (selected.has(d.id)) moved.push(d.id);
  }

  // 4. Rooms, slabs, roofs and stairs.
  for (const id of carriedRooms) {
    const room = doc.rooms?.[id] as Json | undefined;
    const anchor = asPoint(room?.['anchor']);
    if (anchor !== null) ops.push({ op: 'setProperty', id, path: '/anchor', value: r(xf.map(anchor)) });
    const ceiling = room?.['ceiling'];
    const ridge = isObject(ceiling) && Array.isArray(ceiling['ridge']) ? (ceiling['ridge'] as unknown[]).map(asPoint) : null;
    if (ridge !== null && ridge.every((p) => p !== null)) ops.push({ op: 'setProperty', id, path: '/ceiling/ridge', value: ridge.map((p) => r(xf.map(p))) });
    if (selected.has(id)) moved.push(id);
  }
  for (const id of ids) {
    const kind = kindOf(model, id);
    if (kind === 'slab') {
      const boundary = (doc.slabs?.[id] as Json | undefined)?.['boundary'];
      if (Array.isArray(boundary)) {
        ops.push({ op: 'setProperty', id, path: '/boundary', value: boundary.map((p) => r(xf.map(asPoint(p) ?? [0, 0]))) });
        moved.push(id);
      }
    } else if (kind === 'roof') {
      const footprint = (doc.roofs?.[id] as Json | undefined)?.['footprint'];
      if (Array.isArray(footprint)) {
        ops.push({ op: 'setProperty', id, path: '/footprint', value: footprint.map((p) => r(xf.map(asPoint(p) ?? [0, 0]))) });
        moved.push(id);
      }
    } else if (kind === 'stair') {
      const stair = doc.stairs?.[id] as Json | undefined;
      const position = asPoint(stair?.['position']);
      if (stair === undefined || position === null) continue;
      ops.push({ op: 'setProperty', id, path: '/position', value: r(xf.map(position)) });
      const rotation = typeof stair['rotation'] === 'number' ? stair['rotation'] : 0;
      const turned = facingAfter(xf, rotation);
      if (turned !== rotation) ops.push(turned === 0 ? { op: 'unsetProperty', id, path: '/rotation' } : { op: 'setProperty', id, path: '/rotation', value: turned });
      const form = stair['form'];
      if (xf.flip !== null && isObject(form) && (form['turn'] === 'left' || form['turn'] === 'right')) ops.push({ op: 'setProperty', id, path: '/form/turn', value: form['turn'] === 'left' ? 'right' : 'left' });
      moved.push(id);
    } else if (kind === 'wall' || kind === 'separator' || kind === 'junction') {
      moved.push(id);
    } else if (kind !== 'opening' && kind !== 'extensionElement' && kind !== 'room') {
      skipped.push({ id, why: 'it is not drawn on the plan' });
    }
  }
  return { batch: ops, moved, skipped };
}

/**
 * Where a device's host goes under a transform: a new host, null when it stays put (its wall is
 * carried and not turned round), or 'none' when it has no host to move.
 */
function deviceHost(
  level: LevelView,
  d: DeviceView,
  xf: Xform,
  o: { rigid: ReadonlySet<string>; turnedRound: ReadonlySet<string>; carriedRooms: ReadonlySet<string> },
): HostRef | null | 'none' {
  const host = d.host;
  if (host === null) return 'none';
  if (host['mode'] === 'wallFace') {
    const wall = level.walls.find((w) => w.id === host['wall']);
    if (wall === undefined) return 'none';
    const L = Math.floor(lengthOf(wall));
    const offset = Number(host['offset']);
    const side = host['side'] === 'left' ? 'left' : 'right';
    const height = Number(host['height']);
    if (o.turnedRound.has(wall.id)) return { mode: 'wallFace', wall: wall.id, side, at: Math.max(0, Math.min(L, L - offset)), height };
    if (o.rigid.has(wall.id)) return null;
    // Along its face: where the transform takes it, projected back onto its wall.
    const point = d.placement?.point ?? wall.a;
    const at = project(xf.map(point), wall.a, wall.b);
    const next = Math.max(0, Math.min(L, Math.round(at.t * L)));
    if (next === offset) return null;
    return { mode: 'wallFace', wall: wall.id, side, at: next, height };
  }
  const position = asPoint(host['position']);
  if (position === null) return 'none';
  const at = r(xf.map(position));
  const rotation = typeof host['rotation'] === 'number' ? host['rotation'] : 0;
  const turned = facingAfter(xf, rotation);
  if (host['mode'] === 'surface') {
    const room = String(host['room']);
    const surface = host['surface'] === 'ceiling' ? 'ceiling' : 'floor';
    // Carried with its room, it stays in it; otherwise it is in whichever room the point lands in.
    const landed = o.carriedRooms.has(room) ? room : (faceAt(level, at)?.room ?? null);
    if (landed !== null) return { mode: 'surface', room: landed, surface, at, rotation: turned };
    if (surface === 'ceiling') return { mode: 'surface', room, surface, at, rotation: turned };
    return { mode: 'free', level: level.id, at, rotation: turned };
  }
  return { mode: 'free', level: typeof host['level'] === 'string' ? host['level'] : level.id, at, rotation: turned };
}

/** The middle of some elements' bounds, or null when none is on the level. */
export function middleOf(level: LevelView, ids: readonly string[]): Point | null {
  const b = boundsOfIds(level, ids);
  return b === null ? null : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

// ─── Align and distribute ───────────────────────────────────────────────────────────────────

export type Alignment = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/**
 * Align each element's bounds to the selection's: its left edges to the leftmost, its centres to the
 * selection's centre, and so on — each a translation of its own, in one batch. North is up, so
 * "top" is the greatest y.
 */
export function alignBatch(model: EditorModel, level: LevelView, ids: readonly string[], how: Alignment): Transformed {
  const all = boundsOfIds(level, ids);
  if (all === null) return { batch: [], moved: [], skipped: [] };
  return eachBy(model, level, ids, (b) => {
    switch (how) {
      case 'left':
        return [all.minX - b.minX, 0];
      case 'right':
        return [all.maxX - b.maxX, 0];
      case 'centre':
        return [(all.minX + all.maxX) / 2 - (b.minX + b.maxX) / 2, 0];
      case 'top':
        return [0, all.maxY - b.maxY];
      case 'bottom':
        return [0, all.minY - b.minY];
      case 'middle':
        return [0, (all.minY + all.maxY) / 2 - (b.minY + b.maxY) / 2];
    }
  });
}

/**
 * Distribute: the first and last (by their middles, along the axis) stay; those between are moved so
 * the gaps between neighbours' bounds are equal — Figma's "distribute spacing".
 */
export function distributeBatch(model: EditorModel, level: LevelView, ids: readonly string[], axis: 'x' | 'y'): Transformed {
  const items = ids
    .map((id) => ({ id, b: boundsOfIds(level, [id]) }))
    .filter((x): x is { id: string; b: Rect } => x.b !== null)
    .map((x) => ({ ...x, lo: axis === 'x' ? x.b.minX : x.b.minY, hi: axis === 'x' ? x.b.maxX : x.b.maxY }))
    .sort((a, b) => a.lo + a.hi - (b.lo + b.hi));
  if (items.length < 3) return { batch: [], moved: [], skipped: [] };
  const first = items[0] as (typeof items)[number];
  const last = items[items.length - 1] as (typeof items)[number];
  const sizes = items.reduce((s, x) => s + (x.hi - x.lo), 0);
  const gap = (last.hi - first.lo - sizes) / (items.length - 1);
  const target = new Map<string, number>();
  let at = first.lo;
  for (const x of items) {
    target.set(x.id, at);
    at += x.hi - x.lo + gap;
  }
  return eachBy(model, level, ids, (b, id) => {
    const lo = axis === 'x' ? b.minX : b.minY;
    const d = (target.get(id) ?? lo) - lo;
    return axis === 'x' ? [d, 0] : [0, d];
  });
}

/** One translation per element, gathered into one batch; a junction two of them share moves once, by the first. */
function eachBy(model: EditorModel, level: LevelView, ids: readonly string[], by: (b: Rect, id: string) => Point): Transformed {
  const out: Transformed = { batch: [], moved: [], skipped: [] };
  const done = new Set<string>();
  for (const id of ids) {
    const b = boundsOfIds(level, [id]);
    if (b === null) continue;
    const d = r(by(b, id));
    if (d[0] === 0 && d[1] === 0) {
      out.moved.push(id);
      continue;
    }
    // What rides on one goes with it — unless it is one of those aligned itself.
    const one = transformBatch(model, level, [id], translation(d), { except: new Set(ids) });
    // A junction is moved once: a second element that shares it keeps where the first put it.
    const ops = one.batch.filter((op) => {
      if (op.op !== 'moveJunction') return true;
      const j = op.id;
      if (done.has(j)) return false;
      done.add(j);
      return true;
    });
    out.batch.push(...ops);
    out.moved.push(...one.moved);
    out.skipped.push(...one.skipped);
  }
  return out;
}
