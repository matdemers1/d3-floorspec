import type { Vec3 } from '@floorspec/mesh';
import type { EditorModel, LevelView, OpeningView } from '../../model';
import type { DeviceView } from '../../systems/view';
import { frameMotion, frameOf, type Frame } from '../../arrange/carry';

/**
 * Moving what is drawn without meshing the house again (FLR-T-14.8). A drag previews rigidly — the
 * store's rigid preview (rigid.ts, FLR-T-18.18) moves an item's host and nothing else — and the 3D
 * view follows it by moving that item's parts as one body, not by meshing the whole house each
 * pointer move: the motion that takes each item from where the meshed model has it to where the
 * shown model has it. The same motion holds the item where it was dropped until the house is meshed
 * again from the new head, so a drop never flickers back.
 *
 * A motion is in the mesh’s frame — metres about the mesh’s origin, z up: q = Rz(turn)·p + t. FLR-ADR-053.
 */

export interface Motion {
  /** Radians, counter-clockwise about +z. */
  readonly turn: number;
  readonly t: Vec3;
}

export const IDENTITY: Motion = { turn: 0, t: [0, 0, 0] };

/** Apply a motion to a point in the mesh's frame. */
export function moved(m: Motion, p: Vec3): Vec3 {
  const c = Math.cos(m.turn);
  const s = Math.sin(m.turn);
  return [c * p[0] - s * p[1] + m.t[0], s * p[0] + c * p[1] + m.t[1], p[2] + m.t[2]];
}

/**
 * The motion in the mesh's frame of a rigid motion in plan: frame `a` taken to frame `b` (base
 * units, the document's frame), raised by `dz` base units. `origin` and `k` are the mesh's.
 */
export function motionOfFrames(a: Frame, b: Frame, dz: number, origin: Vec3, k: number): Motion {
  const xf = frameMotion(a, b);
  const turn = (xf.turn / 1_000_000) * (Math.PI / 180);
  // Where the mesh's origin goes: the translation of the motion about it.
  const o = xf.map([origin[0], origin[1]]);
  return { turn, t: [(o[0] - origin[0]) / k, (o[1] - origin[1]) / k, dz / k] };
}

type Json = Record<string, unknown>;

const sameHost = (a: Json | null, b: Json | null): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Every element the shown model has somewhere else than the meshed one, and the motion that takes it
 * there — items whose host has changed (a move, a turn, a wall mount raised) and openings slid along
 * a straight wall. What cannot be told rigidly (a resize, an opening on another wall) is left out:
 * the house is meshed again for it.
 */
export function movesBetween(meshed: EditorModel, shown: EditorModel, origin: Vec3, k: number): Map<string, Motion> {
  const out = new Map<string, Motion>();
  if (meshed === shown) return out;
  const was = new Map<string, { d: DeviceView; level: LevelView }>();
  const opened = new Map<string, OpeningView>();
  for (const level of meshed.levels) {
    for (const d of level.devices) was.set(d.id, { d, level });
    for (const o of level.openings) opened.set(o.id, o);
  }
  for (const level of shown.levels) {
    const before = meshed.levels.find((l) => l.id === level.id);
    // A level the shown model shares with the meshed one, untouched: nothing on it has moved.
    if (before === level) continue;
    for (const d of level.devices) {
      const w = was.get(d.id);
      if (w === undefined || w.d === d || sameHost(w.d.host, d.host)) continue;
      const a = frameOf(w.level, w.d.host);
      const b = frameOf(level, d.host);
      if (a === null || b === null) continue;
      if (a.point[0] === b.point[0] && a.point[1] === b.point[1] && a.angle === b.angle && w.d.bottom === d.bottom) continue;
      out.set(d.id, motionOfFrames(a, b, d.bottom - w.d.bottom, origin, k));
    }
    for (const o of level.openings) {
      const w = opened.get(o.id);
      if (w === undefined || w === o || w.wall !== o.wall || w.width !== o.width) continue;
      const wall = level.walls.find((x) => x.id === o.wall);
      if (wall === undefined || wall.line.length > 2) continue;
      const dx = o.start[0] - w.start[0];
      const dy = o.start[1] - w.start[1];
      if (dx === 0 && dy === 0) continue;
      out.set(o.id, { turn: 0, t: [dx / k, dy / k, 0] });
    }
  }
  return out;
}

/** The motion that slides an opening along its straight wall by `by` base units (positive towards the wall's end). */
export function slideMotion(wall: { a: readonly [number, number]; b: readonly [number, number] }, by: number, k: number): Motion {
  const dx = wall.b[0] - wall.a[0];
  const dy = wall.b[1] - wall.a[1];
  const l = Math.hypot(dx, dy) || 1;
  return { turn: 0, t: [((dx / l) * by) / k, ((dy / l) * by) / k, 0] };
}
