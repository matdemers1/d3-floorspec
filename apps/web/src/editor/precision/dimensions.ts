import type { EditorModel, LevelView, Point, Ring, WallView } from '../model';
import { kindOf, labelOf } from '../model';
import { centroid, cross, dist, dot, inFace, inRing, leftNormal, sub } from '../geometry';
import { moveOpening, moveWall, type Batch } from '../ops';
import { transformBatch, translation } from '../arrange/transform';
import { isCovering } from '../arrange/shapes';
import type { DeviceView } from '../systems/view';
import { resizeRoom, roomSides } from '../rooms/edit';
import { BASE_PER_FOOT } from '../units';
import type { DimRef } from './state';

/**
 * Temporary dimensions (FLR-T-18.9), after Revit's: select a wall, an opening, a room or an item and
 * the plan shows how far it is from its neighbours — click a number, type another, and the element
 * moves so that it is that far. Tab changes what the number measures to on the neighbour: its near
 * face, its centre line, its other face. Each edit is one batch — moveWall, moveOpening, or the
 * translation the arrange tools send (FLR-T-18.8) — so one undo.
 *
 * - **a wall**: across to the nearest parallel wall on each side, from its middle;
 * - **an opening**: along its wall, from each edge (or its centre) to the walls that stop it;
 * - **a room**: its clear width and depth, between the walls either side of its middle — the east
 *   and north walls move when they are typed;
 * - **an item**: east, west, north and south to the nearest wall or other item; a wall-hung device
 *   only along its wall.
 *
 * The same distances, never editable, are what ⌥ held over an element shows (Alt-hover).
 *
 * Floats measure, integers move: every value typed goes into an op rounded once (FLR-ADR-004).
 */

export interface TempDim {
  /** Stable while the element stays selected: which side, which axis. */
  key: string;
  /** "From north face", "Width". */
  label: string;
  /** The neighbour, in words, for a screen reader: "the face of W12". */
  to: string;
  neighbour: string;
  /** The dimension line, plan. */
  a: Point;
  b: Point;
  value: number;
  /** Where to draw it off the element: a direction and a distance, plan units, plus pixels; `bare`, without extension lines. */
  shift: { dir: Point; world: number; px: number; bare?: boolean } | null;
  /** An item's half-size across the line, plan units: a short dimension's number goes beside it, clear of its handles. */
  across?: number;
  /** The batch that makes it `value` long, or why it cannot be. Absent: shown, not editable. */
  apply?: (value: number) => { label: string; batch: Batch } | { error: string };
}

/** How far the dimensions look: past this, a neighbour is not a neighbour. */
const REACH = 100 * BASE_PER_FOOT;

const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'] as const;

/** A direction as a compass word, north up the plan. */
export function compass(d: Point): string {
  const a = Math.atan2(d[1], d[0]);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return COMPASS[i] as string;
}

const REF_WORD: Readonly<Record<DimRef, string>> = { face: 'face', centre: 'centre line', far: 'other face' };

export interface Hit {
  id: string;
  /** Along the ray: to its near face, its centre line, its other face. */
  near: number;
  centre: number;
  far: number;
}

const unit = (d: Point): Point => {
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
};
const at = (o: Point, d: Point, t: number): Point => [o[0] + d[0] * t, o[1] + d[1] * t];

/** Where the ray o + d·t meets the line through q along w; null when parallel. */
function rayOnLine(o: Point, d: Point, q: Point, w: Point): number | null {
  const denom = cross(w, d);
  if (Math.abs(denom) < 1e-9) return null;
  return cross(w, sub(q, o)) / denom;
}

/**
 * The first wall a ray meets, measured to its faces and its centre line — the faces as lines, so a
 * mitred or filled corner never confuses which face is near. Walls along the ray are passed by;
 * `parallelTo` keeps only walls parallel to that direction (a wall's neighbours across).
 */
export function castWalls(level: LevelView, o: Point, d: Point, exclude: ReadonlySet<string>, parallelTo?: Point, separators = false): Hit | null {
  let best: Hit | null = null;
  // A room separator (Core 6.2) bounds a room as a wall does, with no thickness.
  const seps = separators ? level.separators.filter((x) => x.line.length <= 2).map((x) => ({ id: x.id, a: x.a, b: x.b, line: x.line, left: 0, right: 0, thickness: 0 })) : [];
  for (const w of [...level.walls, ...seps]) {
    if (exclude.has(w.id) || w.line.length > 2) continue;
    const L = dist(w.a, w.b);
    if (L === 0) continue;
    const u = unit(sub(w.b, w.a));
    if (parallelTo !== undefined && Math.abs(cross(u, parallelTo)) > Math.sin((3 * Math.PI) / 180)) continue;
    const n = leftNormal(w.a, w.b);
    const tl = rayOnLine(o, d, at(w.a, n, w.left), u);
    const tr = rayOnLine(o, d, at(w.a, n, -w.right), u);
    const tc = rayOnLine(o, d, at(w.a, n, (w.left - w.right) / 2), u);
    if (tl === null || tr === null || tc === null) continue;
    const near = Math.min(tl, tr);
    const far = Math.max(tl, tr);
    if (near < -1) continue;
    // Within the wall's length, give or take its thickness at the ends (a corner).
    const s = dot(sub(at(o, d, tc), w.a), u);
    const slack = Math.max(w.left, w.right, w.thickness);
    if (s < -slack || s > L + slack) continue;
    if (near > REACH) continue;
    if (best === null || near < best.near) best = { id: w.id, near: Math.max(0, near), centre: tc, far };
  }
  return best;
}

/** The first item footprint a ray meets: in at its near side, out at its far. */
function castItems(level: LevelView, o: Point, d: Point, exclude: ReadonlySet<string>, ignore: (dv: DeviceView) => boolean): Hit | null {
  let best: Hit | null = null;
  for (const dv of level.devices) {
    if (exclude.has(dv.id) || dv.footprint.length < 3 || ignore(dv)) continue;
    if (inRing(o, dv.footprint)) continue;
    const ts: number[] = [];
    const ring = dv.footprint;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j] as Point;
      const q = ring[i] as Point;
      const e = sub(q, p);
      const t = rayOnLine(o, d, p, e);
      if (t === null || t < 0) continue;
      const s = dot(sub(at(o, d, t), p), e) / dot(e, e);
      if (s >= -1e-9 && s <= 1 + 1e-9) ts.push(t);
    }
    if (ts.length < 2) continue;
    const near = Math.min(...ts);
    const far = Math.max(...ts);
    if (near > REACH) continue;
    if (best === null || near < best.near) best = { id: dv.id, near, centre: (near + far) / 2, far };
  }
  return best;
}

const pick = (h: Hit, ref: DimRef): number => (ref === 'face' ? h.near : ref === 'centre' ? h.centre : h.far);

/** An axis-aligned box of a ring. */
function boxOf(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

const AXES: readonly { key: string; d: Point }[] = [
  { key: 'east', d: [1, 0] },
  { key: 'west', d: [-1, 0] },
  { key: 'north', d: [0, 1] },
  { key: 'south', d: [0, -1] },
];

const neighbourWords = (model: EditorModel, h: Hit, ref: DimRef, item: boolean) =>
  `the ${item ? (ref === 'face' ? 'near side' : ref === 'centre' ? 'centre' : 'far side') : REF_WORD[ref]} of ${labelOf(model, h.id)}`;

/** The temporary dimensions of an element on a level, measured to `ref`; none for what has no neighbours to measure to. */
export function temporaryDimensions(model: EditorModel, level: LevelView, id: string, ref: DimRef): TempDim[] {
  const kind = kindOf(model, id);
  if (kind === 'wall') {
    const wall = level.walls.find((w) => w.id === id);
    return wall === undefined ? [] : wallDims(model, level, wall, ref);
  }
  if (kind === 'opening') return openingDims(model, level, id, ref);
  if (kind === 'room') return roomDims(model, level, id, ref);
  if (kind === 'extensionElement') {
    const device = level.devices.find((d) => d.id === id);
    return device === undefined ? [] : itemDims(model, level, device, ref);
  }
  return [];
}

function wallDims(model: EditorModel, level: LevelView, wall: WallView, ref: DimRef): TempDim[] {
  if (wall.line.length > 2) return [];
  const u = unit(sub(wall.b, wall.a));
  const n = leftNormal(wall.a, wall.b);
  const mid: Point = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
  const out: TempDim[] = [];
  for (const side of [1, -1] as const) {
    const dir: Point = [n[0] * side, n[1] * side];
    // From the face on that side, or (centre) from the middle of the thickness.
    const centreOff = (wall.left - wall.right) / 2;
    const faceOff = side === 1 ? wall.left : -wall.right;
    const o = at(mid, n, ref === 'centre' ? centreOff : faceOff);
    const hit = castWalls(level, o, dir, new Set([wall.id]), u);
    if (hit === null) continue;
    const value = pick(hit, ref);
    if (value <= 0) continue;
    const word = compass(dir);
    out.push({
      key: `wall:${word}`,
      label: `From ${word} ${REF_WORD[ref]}`,
      to: neighbourWords(model, hit, ref, false),
      neighbour: hit.id,
      a: o,
      b: at(o, dir, value),
      value,
      shift: null,
      apply: (v) => {
        // Moving the wall by `by` along its left normal brings a neighbour on that side `by` nearer.
        const by = Math.round(side * (value - v));
        if (by === 0) return { error: `${labelOf(model, wall.id)} is already that far from ${labelOf(model, hit.id)}` };
        return { label: `Move ${labelOf(model, wall.id)}`, batch: moveWall(wall.id, by) };
      },
    });
  }
  return out;
}

function openingDims(model: EditorModel, level: LevelView, id: string, ref: DimRef): TempDim[] {
  const opening = level.openings.find((o) => o.id === id);
  const wall = opening === undefined ? undefined : level.walls.find((w) => w.id === opening.wall);
  if (opening === undefined || wall === undefined || wall.line.length > 2) return [];
  const L = dist(wall.a, wall.b);
  const u = unit(sub(wall.b, wall.a));
  const n = leftNormal(wall.a, wall.b);
  const out: TempDim[] = [];
  for (const end of ['start', 'end'] as const) {
    const dir: Point = end === 'start' ? [-u[0], -u[1]] : u;
    const edge = end === 'start' ? opening.offset : opening.offset + opening.width;
    const from = ref === 'centre' ? opening.offset + opening.width / 2 : edge;
    const o = at(wall.a, u, from);
    const hit = castWalls(level, o, dir, new Set([wall.id]));
    if (hit === null) continue;
    const value = pick(hit, ref);
    if (value <= 0) continue;
    const word = compass(dir);
    out.push({
      key: `opening:${end}`,
      label: `From ${word} ${REF_WORD[ref]}`,
      to: neighbourWords(model, hit, ref, false),
      neighbour: hit.id,
      a: o,
      b: at(o, dir, value),
      value,
      // Beside the wall, on its right (usually the room's) side.
      shift: { dir: [-n[0], -n[1]], world: wall.right, px: 14 },
      apply: (v) => {
        const delta = end === 'start' ? v - value : value - v;
        const offset = Math.round(opening.offset + delta);
        if (offset < 0 || offset + opening.width > L) return { error: `${labelOf(model, id)} would run past the end of ${labelOf(model, wall.id)}` };
        if (offset === opening.offset) return { error: `${labelOf(model, id)} is already there` };
        return { label: `Move ${labelOf(model, id)}`, batch: moveOpening(id, offset) };
      },
    });
  }
  return out;
}

function roomDims(model: EditorModel, level: LevelView, id: string, ref: DimRef): TempDim[] {
  const face = level.faces.find((f) => f.room === id);
  const room = level.rooms.find((r) => r.id === id);
  if (face === undefined || room === undefined) return [];
  const c0 = centroid(face.outer);
  const c = inFace(c0, face) ? c0 : room.anchor;
  const out: TempDim[] = [];
  // Drawn outside the room as a dimension string — past its north wall, and its east — so its
  // numbers never sit on the furniture in the middle of it.
  const north = castWalls(level, c, [0, 1], new Set(), undefined, true);
  const east = castWalls(level, c, [1, 0], new Set(), undefined, true);
  for (const [axis, plus, minus, label] of [
    ['x', [1, 0], [-1, 0], 'Width'],
    ['y', [0, 1], [0, -1], 'Depth'],
  ] as const) {
    const hp = castWalls(level, c, plus, new Set(), undefined, true);
    const hm = castWalls(level, c, minus, new Set(), undefined, true);
    if (hp === null || hm === null) continue;
    const vp = pick(hp, ref);
    const vm = pick(hm, ref);
    const value = vp + vm;
    if (value <= 0) continue;
    const moving = level.walls.find((w) => w.id === hp.id);
    const k = axis === 'x' ? 0 : 1;
    const nk = moving === undefined ? 0 : leftNormal(moving.a, moving.b)[k];
    // FLR-T-18.10's resizeRoom (Ops 4.4) moves the east (north) side when it can — its walls follow as a room's do.
    const side = axis === 'x' ? 'east' : 'north';
    const resizable = roomSides(level, id).some((r) => r.side === side && r.ok);
    out.push({
      key: `room:${axis}`,
      label,
      to: `${neighbourWords(model, hm, ref, false)} to ${neighbourWords(model, hp, ref, false)}`,
      neighbour: hp.id,
      a: at(c, minus, vm),
      b: at(c, plus, vp),
      value,
      shift: axis === 'x' ? { dir: [0, 1], world: north?.far ?? 0, px: 18, bare: true } : { dir: [1, 0], world: east?.far ?? 0, px: 18, bare: true },
      ...(!resizable && Math.abs(nk) < 0.99
        ? {}
        : {
            apply: (v: number) => {
              const grow = Math.round(v - value);
              if (grow === 0) return { error: `${labelOf(model, id)} is already that ${axis === 'x' ? 'wide' : 'deep'}` };
              const label = `Make ${labelOf(model, id)} ${axis === 'x' ? (grow > 0 ? 'wider' : 'narrower') : grow > 0 ? 'deeper' : 'shallower'}`;
              // The east (or north) side out by the difference; else its wall, by along its normal (±x, ±y).
              return { label, batch: resizable ? resizeRoom(id, side, grow) : moveWall(hp.id, Math.round(grow * Math.sign(nk))) };
            },
          }),
    });
  }
  return out;
}

function itemDims(model: EditorModel, level: LevelView, device: DeviceView, ref: DimRef): TempDim[] {
  if (device.footprint.length < 3 && device.placement === null) return [];
  const ring: Ring = device.footprint.length >= 3 ? device.footprint : [device.placement?.point ?? [0, 0]];
  const box = boxOf(ring);
  const c: Point = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  const hostWall = typeof device.host?.['wall'] === 'string' ? level.walls.find((w) => w.id === device.host?.['wall']) : undefined;
  const along = hostWall === undefined ? null : unit(sub(hostWall.b, hostWall.a));
  // What stands under or over it is no neighbour: a rug, the island a cooktop is set in.
  const ignore = (dv: DeviceView) => {
    if (isCovering(dv.element)) return true;
    const b = boxOf(dv.footprint);
    return b.minX < box.maxX && b.maxX > box.minX && b.minY < box.maxY && b.maxY > box.minY;
  };
  const out: TempDim[] = [];
  for (const axis of AXES) {
    // A wall-hung device moves along its wall: across it, nothing to type.
    if (along !== null && Math.abs(dot(along, axis.d)) < 0.99) continue;
    const half = axis.d[0] !== 0 ? (box.maxX - box.minX) / 2 : (box.maxY - box.minY) / 2;
    const o = ref === 'centre' ? c : at(c, axis.d, half);
    const exclude = new Set([device.id, ...(hostWall === undefined ? [] : [hostWall.id])]);
    const w = castWalls(level, o, axis.d, exclude);
    const it = castItems(level, o, axis.d, exclude, ignore);
    const hit = w === null ? it : it === null ? w : it.near < w.near ? it : w;
    if (hit === null) continue;
    const value = pick(hit, ref);
    if (value <= 0) continue;
    const item = hit === it;
    out.push({
      key: `item:${axis.key}`,
      label: `From ${axis.key} ${item ? (ref === 'face' ? 'side' : ref === 'centre' ? 'centre' : 'far side') : REF_WORD[ref]}`,
      to: neighbourWords(model, hit, ref, item),
      neighbour: hit.id,
      a: o,
      b: at(o, axis.d, value),
      value,
      shift: null,
      across: axis.d[0] !== 0 ? (box.maxY - box.minY) / 2 : (box.maxX - box.minX) / 2,
      apply: (v) => {
        const by = value - v;
        const d: Point = [Math.round(axis.d[0] * by), Math.round(axis.d[1] * by)];
        if (d[0] === 0 && d[1] === 0) return { error: `${labelOf(model, device.id)} is already there` };
        const t = transformBatch(model, level, [device.id], translation(d));
        if (t.batch.length === 0) return { error: t.skipped[0]?.why ?? `${labelOf(model, device.id)} cannot move that way` };
        return { label: `Move ${labelOf(model, device.id)}`, batch: t.batch };
      },
    });
  }
  return out;
}
