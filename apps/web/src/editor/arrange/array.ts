import type { Operation } from '@floorspec/ops';
import type { EditorModel, LevelView, Point, WallView } from '../model';
import { dist, faceAt } from '../geometry';
import { nearestFace } from '../systems/placement';
import type { Batch } from '../ops';
import { copyClip, pasteBatch } from './clipboard';
import { boundsOfIds } from './shapes';
import { transformBatch, translation } from './transform';

/**
 * Array and copy along a wall (FLR-T-18.8; AutoCAD's ARRAY, Chief Architect's Multiple Copy): the
 * selection repeated along a line, along a wall face, or in a grid — recessed lights down a room,
 * outlets along a run, cabinets along a wall, chairs along a table. The plan is worked out here as
 * offsets from where the selection is; the batch is a paste of the selection at each of them (and,
 * when the row is set a distance off its wall, the selection moved onto that line) — one batch,
 * one undo.
 *
 * `count` is how many there are in the row, the original among them (as AutoCAD and Revit count).
 */

export type ArrayMode = 'line' | 'wall' | 'grid';

export interface ArraySpec {
  mode: ArrayMode;
  /** In a row, the original included; in a grid, the columns. */
  count: number;
  /** In a grid, the rows. */
  rows: number;
  /** Centre to centre, base units. */
  spacing: number;
  /** A line's direction, degrees counter-clockwise from east. */
  direction: 0 | 90 | 180 | 270;
  /** Along a wall: which way, +1 toward its end junction. */
  sense: 1 | -1;
  /** Along a wall: the row's distance off the wall's face; null keeps it where it is. */
  offset: number | null;
  /** Along a wall: spread `count` evenly between the room's ends, instead of at `spacing`. */
  fit: boolean;
  /** Put each copy on its original's circuit. */
  keepCircuit: boolean;
}

export interface WallRef {
  wall: WallView;
  /** Unit vector along the wall, start → end. */
  dir: Point;
  /** Unit vector off the face the selection is on, into the room. */
  inward: Point;
  /** The selection's middle, along the wall from its start. */
  at: number;
  /** The selection's distance off the face; null when it is on the wall itself. */
  off: number | null;
  /** The room's extent along the wall, from its start: where "fit between" spreads the row. */
  span: [number, number];
}

export interface ArrayPlan {
  /** Each copy's offset from where its original is now. */
  offsets: Point[];
  /** The selection moved by this first (onto the row's line, or to the row's first place). */
  move: Point;
  /** The centre-to-centre spacing the row comes out at. */
  spacing: number;
  wall: WallRef | null;
}

const unit = (v: Point): Point => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

/** The wall a selection is arrayed along: a wall-face device's own, else the face nearest its middle. */
export function wallRef(level: LevelView, ids: readonly string[]): WallRef | null {
  const b = boundsOfIds(level, ids);
  if (b === null) return null;
  const mid: Point = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  const hosted = ids.map((id) => level.devices.find((d) => d.id === id)).find((d) => d?.host?.['mode'] === 'wallFace');
  let wall: WallView | undefined;
  let side: 'left' | 'right';
  let off: number | null;
  if (hosted !== undefined && hosted.host !== null) {
    wall = level.walls.find((w) => w.id === hosted.host?.['wall']);
    side = hosted.host['side'] === 'left' ? 'left' : 'right';
    off = null;
  } else {
    const face = nearestFace(level, mid, 30 * 390_144);
    wall = face?.wall;
    side = face?.side ?? 'right';
    off = face === null ? null : Math.round(face.distance);
  }
  if (wall === undefined) return null;
  const L = dist(wall.a, wall.b);
  const dir = unit([wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]]);
  const left: Point = [-dir[1], dir[0]];
  const inward: Point = side === 'left' ? left : [-left[0], -left[1]];
  const at = (mid[0] - wall.a[0]) * dir[0] + (mid[1] - wall.a[1]) * dir[1];
  // The room the row is in: under the selection, or just off the wall face for a wall device.
  const probe: Point = off === null ? [mid[0] + inward[0] * 64_000, mid[1] + inward[1] * 64_000] : mid;
  const face = faceAt(level, probe);
  let span: [number, number] = [0, L];
  if (face !== undefined) {
    const s = face.outer.map((p) => (p[0] - wall.a[0]) * dir[0] + (p[1] - wall.a[1]) * dir[1]);
    span = [Math.max(Math.min(...s), off === null ? 0 : -Infinity), Math.min(Math.max(...s), off === null ? L : Infinity)];
  }
  return { wall, dir, inward, at, off, span };
}

/** A first plan: along the wall the selection is near, at the grid's 6′ (or 1.8 m), four in the row. */
export function defaultSpec(level: LevelView, ids: readonly string[], metric: boolean): ArraySpec {
  const ref = wallRef(level, ids);
  const spacing = metric ? 1800 * 1280 : 6 * 390_144;
  // Toward the farther end of the room, where there is space for the row.
  const sense: 1 | -1 = ref === null || ref.at <= (ref.span[0] + ref.span[1]) / 2 ? 1 : -1;
  return { mode: ref === null ? 'line' : 'wall', count: 4, rows: 2, spacing, direction: 0, sense, offset: ref?.off ?? null, fit: false, keepCircuit: true };
}

/** Where the copies go. Null when the plan has nothing to repeat. */
export function planArray(level: LevelView, ids: readonly string[], spec: ArraySpec): ArrayPlan | null {
  const count = Math.max(1, Math.min(100, Math.round(spec.count)));
  const rows = Math.max(1, Math.min(100, Math.round(spec.rows)));
  if (boundsOfIds(level, ids) === null) return null;
  const s = spec.spacing;
  if (spec.mode === 'grid') {
    const offsets: Point[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < count; i++) if (i !== 0 || j !== 0) offsets.push([i * s, -j * s]);
    return { offsets, move: [0, 0], spacing: s, wall: null };
  }
  if (spec.mode === 'line') {
    const rad = (spec.direction * Math.PI) / 180;
    const v: Point = [Math.round(Math.cos(rad)), Math.round(Math.sin(rad))];
    return { offsets: Array.from({ length: count - 1 }, (_, i) => [v[0] * s * (i + 1), v[1] * s * (i + 1)] as Point), move: [0, 0], spacing: s, wall: null };
  }
  const ref = wallRef(level, ids);
  if (ref === null) return null;
  const { dir, inward } = ref;
  // Off the wall: onto the row's line, `offset` from the face.
  const across = ref.off !== null && spec.offset !== null ? spec.offset - ref.off : 0;
  let along = 0;
  let spacing = s;
  let steps: number[];
  if (spec.fit) {
    const [a, b] = ref.span;
    spacing = (b - a) / count;
    const places = Array.from({ length: count }, (_, i) => a + (i + 0.5) * spacing);
    along = (places[0] ?? ref.at) - ref.at;
    steps = places.slice(1).map((p) => p - (places[0] ?? 0));
  } else {
    steps = Array.from({ length: count - 1 }, (_, i) => spec.sense * s * (i + 1));
  }
  const move: Point = [Math.round(dir[0] * along + inward[0] * across), Math.round(dir[1] * along + inward[1] * across)];
  const offsets = steps.map((k): Point => [Math.round(move[0] + dir[0] * k), Math.round(move[1] + dir[1] * k)]);
  return { offsets, move, spacing: Math.round(spacing), wall: ref };
}

/** The array's batch: the selection moved onto its row if it must be, and pasted at each offset. */
export function arrayBatch(model: EditorModel, level: LevelView, ids: readonly string[], spec: ArraySpec, o: { attempt: number; project: string }): { batch: Batch; ids: string[] } {
  const plan = planArray(level, ids, spec);
  const clip = copyClip(model, level, ids, o.project);
  if (plan === null || clip === null || plan.offsets.length === 0) return { batch: [], ids: [] };
  const moved = plan.move[0] === 0 && plan.move[1] === 0 ? [] : transformBatch(model, level, ids, translation(plan.move)).batch;
  const pasted = pasteBatch(model, level, clip, { offsets: plan.offsets, attempt: o.attempt, sameProject: true, keepCircuits: spec.keepCircuit });
  return { batch: [...moved, ...pasted.batch] as Operation[], ids: pasted.ids };
}
