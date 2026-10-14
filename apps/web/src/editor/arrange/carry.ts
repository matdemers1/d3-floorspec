import { facingVector, Surd } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import type { EditorModel, LevelView, Point } from '../model';
import { leftNormal } from '../geometry';
import type { Batch } from '../ops';
import { angleOf, facePoint } from '../systems/placement';
import type { DeviceView } from '../systems/view';
import { ridersOf } from './riders';
import { halfOpen, transformBatch, type Xform } from './transform';

/**
 * FLR-T-18.18: every edit the editor sends carries what sits on the items it moves (riders.ts). The
 * store runs each batch through `carryRiders` before it is previewed or posted, so a drag, an arrow
 * key, a typed position in the inspector, a turn and a resize all take the cooktop with the island —
 * in the same batch, so the edit and what it carries are one transaction and one undo step.
 *
 * Moves and turns: an item's host frame (its point and facing, Core 13.4) before and after the batch
 * gives the rigid motion that took it there, and its riders are taken by that same motion
 * (arrange/transform.ts, which re-hosts each one where it lands). Resizes: resizeElement moves the
 * item's own `with` group (Ops 0.4, 4.11); a rider that is not grouped with it — another extension's
 * element on its top — is moved here exactly as 4.11 moves a grouped one.
 *
 * A rider the batch already moves itself (selected with the item, or carried by a transform of the
 * selection) is left as the batch has it.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asPoint = (v: unknown): Point | null => (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** A host frame in plan (Core 13.4): its origin, and its facing in microdegrees. */
export interface Frame {
  point: Point;
  angle: number;
}

/** The frame a host puts an element in, on `level`; null when it cannot be told from the host alone. */
export function frameOf(level: LevelView, host: Json | null): Frame | null {
  if (host === null) return null;
  const mode = host['mode'];
  if (mode === 'surface' || mode === 'free') {
    const point = asPoint(host['position']);
    if (point === null) return null;
    return { point, angle: isInt(host['rotation']) ? host['rotation'] : 0 };
  }
  if (mode === 'wallFace') {
    const wall = level.walls.find((w) => w.id === host['wall']);
    const offset = host['offset'];
    if (wall === undefined || typeof offset !== 'number') return null;
    const side = host['side'] === 'left' ? 'left' : 'right';
    const n = leftNormal(wall.a, wall.b);
    return { point: facePoint(wall, side, offset), angle: angleOf(side === 'left' ? n : [-n[0], -n[1]]) };
  }
  return null;
}

/** The rigid motion that takes frame `a` to frame `b`: turned by the difference of their facings about `a`, then moved onto `b`. */
export function frameMotion(a: Frame, b: Frame): Xform {
  const turn = halfOpen(b.angle - a.angle);
  // Quarter turns exactly; any other angle to the nearest base unit when the transform's points are rounded.
  const q = turn % 90_000_000 === 0 ? (((turn / 90_000_000) % 4) + 4) % 4 : null;
  const rad = (turn / 1_000_000) * (Math.PI / 180);
  const c = q === null ? Math.cos(rad) : [1, 0, -1, 0][q] as number;
  const s = q === null ? Math.sin(rad) : [0, 1, 0, -1][q] as number;
  const map = (p: Point): Point => {
    const x = p[0] - a.point[0];
    const y = p[1] - a.point[1];
    return [b.point[0] + c * x - s * y, b.point[1] + s * x + c * y];
  };
  return { map, turn, flip: null };
}

/** The ID an operation acts on, for the ops that act on one element. */
function targetOf(op: Operation): string | null {
  const o = op as unknown as Json;
  const t = o['element'] ?? o['id'];
  return typeof t === 'string' ? t : null;
}

/** Every element ID an operation names (its target, a host's wall or room aside). */
function namedBy(op: Operation): string[] {
  const o = op as unknown as Json;
  return ['element', 'id', 'opening', 'room'].map((k) => o[k]).filter((v): v is string => typeof v === 'string');
}

/**
 * A device's host after the batch's ops on it: a moveElement's host reference resolved as the applier
 * resolves a plain one, and any setProperty or unsetProperty of `/host` or one of its members.
 * 'unknown' when a host reference names its side by `toward`, or a position by anything but numbers.
 */
export function hostAfterOps(host: Json | null, ops: readonly Operation[]): Json | null | 'unknown' {
  let h: Json | null = host === null ? null : { ...host };
  for (const op of ops) {
    const o = op as unknown as Json;
    if (o['op'] === 'moveElement') {
      const ref = o['host'];
      if (!isObject(ref)) return 'unknown';
      const rotation = ref['rotation'];
      if (ref['mode'] === 'surface' || ref['mode'] === 'free') {
        const at = asPoint(ref['at']);
        if (at === null) return 'unknown';
        h = ref['mode'] === 'surface'
          ? { mode: 'surface', room: ref['room'], surface: ref['surface'], position: [at[0], at[1]] }
          : { mode: 'free', level: ref['level'], position: [at[0], at[1]] };
        if (rotation !== undefined) h['rotation'] = rotation;
      } else if (ref['mode'] === 'wallFace') {
        if (typeof ref['side'] !== 'string' || typeof ref['at'] !== 'number') return 'unknown';
        h = { mode: 'wallFace', wall: ref['wall'], side: ref['side'], offset: ref['at'], height: ref['height'] };
      } else return 'unknown';
      continue;
    }
    const path = o['path'];
    if (typeof path !== 'string' || (path !== '/host' && !path.startsWith('/host/'))) continue;
    if (o['op'] === 'setProperty') {
      if (path === '/host') h = isObject(o['value']) ? { ...o['value'] } : null;
      else if (h !== null && !path.slice(6).includes('/')) h[path.slice(6)] = o['value'];
      else return 'unknown';
    } else if (o['op'] === 'unsetProperty') {
      if (path === '/host') h = null;
      else if (h !== null && !path.slice(6).includes('/')) Reflect.deleteProperty(h, path.slice(6));
    }
  }
  return h;
}

const sameFrame = (a: Frame, b: Frame): boolean => a.point[0] === b.point[0] && a.point[1] === b.point[1] && halfOpen(a.angle - b.angle) === 0;

/** The batch with the moves of what rides on everything it moves, turns or resizes appended. */
export function carryRiders(model: EditorModel, batch: Batch): Batch {
  if (batch.length === 0) return batch;
  const where = new Map<string, { d: DeviceView; level: LevelView }>();
  for (const level of model.levels) for (const d of level.devices) where.set(d.id, { d, level });
  // Grouped by the device each op acts on, in the order the batch first touches them.
  const byDevice = new Map<string, Operation[]>();
  const touched = new Set<string>();
  for (const op of batch) {
    for (const id of namedBy(op)) touched.add(id);
    const id = targetOf(op);
    if (id !== null && where.has(id)) byDevice.set(id, [...(byDevice.get(id) ?? []), op]);
  }
  if (byDevice.size === 0) return batch;
  const out: Batch = [...batch];
  for (const [id, ops] of byDevice) {
    const { d, level } = where.get(id) as { d: DeviceView; level: LevelView };
    const resize = ops.find((op) => op.op === 'resizeElement');
    if (resize !== undefined) {
      out.push(...resizeRiders(level, d, resize as unknown as Json, touched));
      continue;
    }
    const after = hostAfterOps(d.host, ops);
    if (after === 'unknown' || after === null) continue;
    // Moved off this level (a host on another level's room or wall): its riders are not carried there.
    if (after['mode'] === 'surface' && !level.rooms.some((r) => r.id === after['room'])) continue;
    if (after['mode'] === 'free' && after['level'] !== level.id) continue;
    const a = frameOf(level, d.host);
    const b = frameOf(level, after);
    if (a === null || b === null || sameFrame(a, b)) continue;
    const riders = ridersOf(level, [id], touched);
    if (riders.length === 0) continue;
    for (const r of riders) touched.add(r);
    out.push(...transformBatch(model, level, riders, frameMotion(a, b), { carry: false }).batch);
  }
  return out;
}

// ─── Resizing (Ops 0.4, 4.11) ────────────────────────────────────────────────────────────────

type Hold = 'min' | 'max' | 'mid';
const RESIZE_HOLD: Readonly<Record<string, readonly [Hold, Hold]>> = {
  center: ['mid', 'mid'],
  back: ['min', 'mid'],
  front: ['max', 'mid'],
  right: ['mid', 'min'],
  left: ['mid', 'max'],
  'back-right': ['min', 'min'],
  'back-left': ['min', 'max'],
  'front-right': ['max', 'min'],
  'front-left': ['max', 'max'],
};
const BOX_AXES = ['depth', 'width', 'height'] as const;
const floorHalf = (e: bigint): bigint => (e >= 0n ? e / 2n : -((-e + 1n) / 2n));
const triple = (v: unknown): [bigint, bigint, bigint] | null => (Array.isArray(v) && v.length === 3 && v.every(isInt) ? [BigInt(v[0] as number), BigInt(v[1] as number), BigInt(v[2] as number)] : null);

/**
 * What a resizeElement of `d` does to what rides on it but is not in its `with` group (the applier
 * moves those itself): each moved by the shift of the part of the item its origin stands by, as 4.11
 * moves a grouped element — exactly, in the same arithmetic — and raised with the top it stands on.
 */
function resizeRiders(level: LevelView, d: DeviceView, op: Json, touched: Set<string>): Batch {
  const riders = ridersOf(level, [d.id], touched)
    .map((id) => level.devices.find((x) => x.id === id))
    .filter((x): x is DeviceView => x !== undefined && x.element['with'] !== d.id);
  const fb = d.element['fallback'];
  const box = isObject(fb) ? fb['box'] : undefined;
  const lo = isObject(box) ? triple(box['min']) : null;
  const hi = isObject(box) ? triple(box['max']) : null;
  const holds = RESIZE_HOLD[String(op['anchor'])];
  if (riders.length === 0 || lo === null || hi === null || holds === undefined) return [];
  const hold: readonly Hold[] = [...holds, 'min'];
  const olds: [bigint, bigint][] = [];
  const news: [bigint, bigint][] = [];
  for (const [i, ax] of BOX_AXES.entries()) {
    const a = lo[i] as bigint;
    const b = hi[i] as bigint;
    const e = b - a;
    const sized = op[ax];
    if (sized !== undefined && !isInt(sized)) return [];
    const e2 = sized === undefined ? e : BigInt(sized);
    const a2 = hold[i] === 'min' ? a : hold[i] === 'max' ? b - e2 : a + floorHalf(e) - floorHalf(e2);
    olds.push([a, b]);
    news.push([a2, a2 + e2]);
  }
  const shift2 = (i: number, c: Surd): bigint => {
    const [a, b] = olds[i] as [bigint, bigint];
    const [a2, b2] = news[i] as [bigint, bigint];
    if (c.cmp(Surd.of(a)) <= 0) return 2n * (a2 - a);
    if (c.cmp(Surd.of(b)) >= 0) return 2n * (b2 - b);
    return a2 - a + (b2 - b);
  };
  const h = d.host;
  const ePos = h === null ? [0n, 0n] : (asPoint(h['position'])?.map((n) => BigInt(n)) ?? null);
  const out: Batch = [];
  for (const g of riders) {
    touched.add(g.id);
    const gPos = asPoint(g.host?.['position']);
    if (ePos !== null && gPos !== null && (h === null || h['mode'] === 'free' || h['mode'] === 'surface')) {
      const rot = h?.['rotation'];
      const [fx, fy] = h === null ? [1n, 0n] : facingVector(isInt(rot) ? rot : 0);
      const M = fx * fx + fy * fy;
      const dx = BigInt(gPos[0]) - (ePos[0] as bigint);
      const dy = BigInt(gPos[1]) - (ePos[1] as bigint);
      const root = Surd.sqrt(M);
      const x = root.mulInt(dx * fx + dy * fy).divInt(M);
      const y = root.mulInt(-dx * fy + dy * fx).divInt(M);
      const sx2 = shift2(0, x);
      const sy2 = shift2(1, y);
      const mx = root.mulInt(sx2 * fx - sy2 * fy).divInt(2n * M).round();
      const my = root.mulInt(sx2 * fy + sy2 * fx).divInt(2n * M).round();
      if (mx !== 0n || my !== 0n) out.push({ op: 'setProperty', id: g.id, path: '/host/position', value: [Number(BigInt(gPos[0]) + mx), Number(BigInt(gPos[1]) + my)] });
    }
    // Standing on the top: raised or lowered with it (4.11's grouped elements on the same ground).
    const dz = (news[2] as [bigint, bigint])[1] - (olds[2] as [bigint, bigint])[1];
    const gfb = g.element['fallback'];
    const gbox = isObject(gfb) ? gfb['box'] : undefined;
    const gmn = isObject(gbox) ? triple(gbox['min']) : null;
    const gmx = isObject(gbox) ? triple(gbox['max']) : null;
    if (dz !== 0n && gmn !== null && gmx !== null && gmn[2] >= (olds[2] as [bigint, bigint])[1]) {
      out.push({ op: 'setProperty', id: g.id, path: '/fallback/box', value: { min: [Number(gmn[0]), Number(gmn[1]), Number(gmn[2] + dz)], max: [Number(gmx[0]), Number(gmx[1]), Number(gmx[2] + dz)] } });
    }
  }
  return out;
}
