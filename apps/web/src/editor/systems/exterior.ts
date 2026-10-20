import { EXTERIOR_DEFAULTS, walksOf, type Walk } from '@floorspec/assistant-electrical';
import { beamWords, EXTERIOR_DEFS, exteriorOf, stringBox, bulbCount, type ExteriorKind } from '@floorspec/render2d';
import type { EditorModel, LevelView, Point } from '../model';
import { dist, project } from '../geometry';
import { formatLen, type UnitSystem } from '../units';
import type { Box, DeviceKind } from './catalog';
import type { DeviceHover } from './placement';
import { angleOf, facePoint, nearestFace } from './placement';
import type { DeviceView } from './view';

/**
 * Placing exterior lights on the plan (FLR-T-15.5, the board's "15.5 · Exterior lighting"): where
 * each kind snaps — a path light to a walk's edge at the spacing from the one before it, an uplight
 * to a tree's canopy or a wall's foot, a step light to a stair's riser, a string between two points —
 * and what the tool says while it does. Worked out here without React so it can be tested; every
 * placement is still one placeElement the applier resolves (FLR-ADR-008).
 */

const IN = 32_512;
const FT = 12 * IN;
const MICRO = 1_000_000;

/** What an exterior hover adds to a device hover: the box and the record its element is placed with, and what the tool says. */
export interface ExteriorHoverExtra {
  box?: Box;
  patch?: { beam?: number; reach?: number; bulbs?: number };
  /** The status line: "Along the walk · 8′-0″ apart · alternating sides". */
  hint?: string;
  /** A short tag by the ghost: "8′-0″ to X12", "into the canopy". */
  tag?: string;
}

const walkCache = new WeakMap<EditorModel, Map<string, Walk[]>>();

/** The walks and drives of a level (the assistant's reading of slabs and hardscape), kept per model. */
export function levelWalks(model: EditorModel, level: string): Walk[] {
  let byLevel = walkCache.get(model);
  if (byLevel === undefined) {
    byLevel = new Map();
    walkCache.set(model, byLevel);
  }
  const known = byLevel.get(level);
  if (known !== undefined) return known;
  const walks = model.derived === null ? [] : walksOf({ document: model.view, derived: model.derived }, EXTERIOR_DEFAULTS, level);
  byLevel.set(level, walks);
  return walks;
}

/** The nearest point on a walk's centre line: how far along it, its unit direction there, and how far off it. */
function onWalk(walk: Walk, p: Point): { t: number; at: Point; u: Point; off: number; side: 1 | -1 } {
  let best = { t: 0, at: walk.line[0] as Point, u: [1, 0] as Point, off: Infinity, side: 1 as 1 | -1 };
  let run = 0;
  for (let i = 1; i < walk.line.length; i++) {
    const a = walk.line[i - 1] as Point;
    const b = walk.line[i] as Point;
    const l = dist(a, b);
    if (l === 0) continue;
    const pr = project(p, a, b);
    const t = Math.min(1, Math.max(0, pr.t));
    const at: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const off = dist(p, at);
    if (off < best.off) {
      const u: Point = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      const cross = u[0] * (p[1] - at[1]) - u[1] * (p[0] - at[0]);
      best = { t: run + t * l, at, u, off, side: cross >= 0 ? 1 : -1 };
    }
    run += l;
  }
  return best;
}

/** The point at a distance along a walk's centre line, and its direction there. */
function alongWalk(walk: Walk, t: number): { at: Point; u: Point } {
  let rest = t;
  for (let i = 1; i < walk.line.length; i++) {
    const a = walk.line[i - 1] as Point;
    const b = walk.line[i] as Point;
    const l = dist(a, b);
    if (rest <= l || i === walk.line.length - 1) {
      const k = l === 0 ? 0 : Math.min(Math.max(rest, 0), l) / l;
      return { at: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], u: l === 0 ? [1, 0] : [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
    }
    rest -= l;
  }
  return { at: walk.line[0] as Point, u: [1, 0] };
}

const snap = (p: Point, grid: number): [number, number] => [Math.round(p[0] / grid) * grid, Math.round(p[1] / grid) * grid];

/** An exterior light of a kind on the level: its device view, when it is one. */
const exteriorKindOf = (d: DeviceView): ExteriorKind | null => (d.extension === 'FS_electrical' && d.collection === 'lights' ? (exteriorOf(d.element)?.kind ?? null) : null);

/** The trees of a level: FS_landscape plants of form tree, their centres and canopies' radii. */
function treesOf(level: LevelView): { id: string; centre: Point; radius: number }[] {
  return level.devices.flatMap((d) => {
    if (d.extension !== 'FS_landscape' || d.collection !== 'plants' || d.element['form'] !== 'tree' || d.placement === null) return [];
    const box = (d.element['fallback'] as { box?: { min?: number[]; max?: number[] } } | undefined)?.box;
    const r = box?.max !== undefined && box.min !== undefined ? Math.max((box.max[0] ?? 0) - (box.min[0] ?? 0), (box.max[1] ?? 0) - (box.min[1] ?? 0)) / 2 : 0;
    return r > 0 ? [{ id: d.id, centre: d.placement.point, radius: r }] : [];
  });
}

export interface ExteriorHoverOptions {
  grid: number;
  tol: number;
  units: UnitSystem;
  /** For a string light: where its run starts, once a first point is chosen. */
  from?: Point | null;
}

/**
 * Where an exterior light of `kind` would go at `p` (FLR-T-15.5). Null for a kind that is not an
 * exterior kind, or a wall-mounted one — a wall-washer is placed on a wall face as any wall device is.
 */
export function exteriorHover(model: EditorModel, level: LevelView, kind: DeviceKind, p: Point, o: ExteriorHoverOptions): (DeviceHover & ExteriorHoverExtra) | null {
  const ext = kind.exterior;
  if (ext === undefined || kind.mount === 'wall') return null;
  const free = (at: Point, rotation: number, extra: ExteriorHoverExtra = {}): DeviceHover & ExteriorHoverExtra => {
    const pos = snap(at, 1);
    const rad = (rotation / MICRO) * (Math.PI / 180);
    return { host: { mode: 'free', level: level.id, at: pos, ...(rotation === 0 ? {} : { rotation }) }, point: pos, facing: [Math.cos(rad), Math.sin(rad)], ...extra };
  };
  const def = EXTERIOR_DEFS[ext];
  if (ext === 'string') {
    const from = o.from ?? null;
    if (from === null) return free(snap(p, o.grid), 0, { hint: 'String lights · click where the run starts, then where it ends' });
    const end = snap(p, o.grid);
    const len = Math.round(dist(from, end));
    if (len < 2 * FT) return free(from, 0, { hint: 'String lights · a run is at least 2′ long', tag: 'too short' });
    const rotation = Math.round((angleOf([end[0] - from[0], end[1] - from[1]]) / MICRO)) * MICRO;
    const n = bulbCount(len);
    return free(from, rotation, { box: stringBox(len), patch: { bulbs: n }, hint: `String lights · ${formatLen(len, o.units)} run · ${String(n)} bulbs, 8′ up`, tag: `${formatLen(len, o.units)} · ${String(n)} bulbs` });
  }
  if (ext === 'path') {
    // The walk nearest the pointer, within its edge and a little past where a path light stands.
    const reach = (w: Walk) => w.halfWidth + EXTERIOR_DEFAULTS.setback + 3 * FT;
    const near = levelWalks(model, level.id)
      .map((w) => ({ w, on: onWalk(w, p) }))
      .filter((x) => x.on.off <= reach(x.w))
      .sort((a, b) => a.on.off - b.on.off)[0];
    if (near === undefined) return free(snap(p, o.grid), 0, { hint: `${def.label} · ${beamWords(def.beam)} pool · near a walk it snaps to its edge, ${formatLen(EXTERIOR_DEFAULTS.walkSpacing, o.units)} apart` });
    const { w, on } = near;
    const spacing = w.kind === 'drive' ? EXTERIOR_DEFAULTS.driveSpacing : EXTERIOR_DEFAULTS.walkSpacing;
    const off = w.halfWidth + EXTERIOR_DEFAULTS.setback;
    // The path lights already along this walk, by where they are along it and on which side.
    const along = level.devices
      .filter((d) => exteriorKindOf(d) === 'path' && d.placement !== null)
      .map((d) => ({ d, on: onWalk(w, d.placement?.point ?? [0, 0]) }))
      .filter((x) => x.on.off <= off + 2 * FT);
    const neighbour = along.sort((a, b) => Math.abs(a.on.t - on.t) - Math.abs(b.on.t - on.t))[0];
    let t = Math.round(on.t / o.grid) * o.grid;
    let side: 1 | -1 = on.side;
    let tag: string | undefined;
    if (neighbour !== undefined && Math.abs(neighbour.on.t - on.t) <= 1.6 * spacing) {
      t = neighbour.on.t + (on.t >= neighbour.on.t ? spacing : -spacing);
      // Alternating sides along a walk; a drive keeps to one side.
      side = w.kind === 'drive' ? neighbour.on.side : neighbour.on.side === 1 ? -1 : 1;
      tag = `${formatLen(spacing, o.units)} to ${neighbour.d.id}`;
    }
    const { at, u } = alongWalk(w, t);
    const n: Point = [-u[1] * side, u[0] * side];
    const pos: Point = [at[0] + n[0] * off, at[1] + n[1] * off];
    const rotation = Math.round(angleOf([-n[0], -n[1]]) / MICRO) * MICRO;
    return free(pos, rotation, {
      hint: `Along the ${w.kind === 'drive' ? 'drive' : 'walk'} · ${formatLen(spacing, o.units)} apart · ${w.kind === 'drive' ? 'one side' : 'alternating sides'}`,
      ...(tag === undefined ? {} : { tag }),
    });
  }
  if (ext === 'uplight') {
    // Into a tree's canopy: just outside its edge on the pointer's side, aimed at its trunk.
    const tree = treesOf(level)
      .map((t) => ({ t, d: dist(p, t.centre) }))
      .filter((x) => x.d <= x.t.radius * 1.5 + o.tol)
      .sort((a, b) => a.d - b.d)[0];
    if (tree !== undefined) {
      const { centre, radius } = tree.t;
      const away: Point = tree.d === 0 ? [-1, 0] : [(p[0] - centre[0]) / tree.d, (p[1] - centre[1]) / tree.d];
      const r = Math.round(radius * 1.1);
      const pos: Point = [centre[0] + away[0] * r, centre[1] + away[1] * r];
      const rotation = Math.round(angleOf([-away[0], -away[1]]) / MICRO) * MICRO;
      return free(pos, rotation, { patch: { reach: r }, hint: `Uplight · into the canopy · ${beamWords(def.beam)}`, tag: 'into the canopy' });
    }
    // Up a wall: 18″ out from its face, aimed at it.
    const face = nearestFace(level, p, 3 * FT);
    if (face !== null) {
      const wall = face.wall;
      const at = facePoint(wall, face.side, face.offset);
      const l = dist(at, p) || 1;
      const out: Point = [(p[0] - at[0]) / l, (p[1] - at[1]) / l];
      const pos: Point = [at[0] + out[0] * 18 * IN, at[1] + out[1] * 18 * IN];
      const rotation = Math.round(angleOf([-out[0], -out[1]]) / MICRO) * MICRO;
      return free(pos, rotation, { patch: { reach: 18 * IN }, hint: `Uplight · up the wall · ${beamWords(def.beam)}`, tag: 'up the wall' });
    }
    return free(snap(p, o.grid), 0, { hint: `Uplight · ${beamWords(def.beam)} · near a tree it aims into the canopy, near a wall up its face` });
  }
  // A step light: in the riser of a stair on this level, else on the ground.
  const derived = model.derived;
  const risers: { at: Point; rotation: number; z: number; d: number; label: string }[] = [];
  for (const [sid, st] of Object.entries(derived?.stairs ?? {})) {
    const s = model.view.stairs?.[sid] as { level?: string; name?: string } | undefined;
    if (s?.level !== level.id || st.steps === undefined) continue;
    const down: Point = [st.foot[0] - st.head[0], st.foot[1] - st.head[1]];
    const dl = Math.hypot(down[0], down[1]) || 1;
    const u: Point = [down[0] / dl, down[1] / dl];
    let below = st.bottom;
    for (const [i, step] of st.steps.entries()) {
      if (step.landing !== true) {
        const c: Point = [step.outline.reduce((a, q) => a + q[0], 0) / step.outline.length, step.outline.reduce((a, q) => a + q[1], 0) / step.outline.length];
        const going = Math.max(...step.outline.map((q) => q[0] * u[0] + q[1] * u[1])) - (c[0] * u[0] + c[1] * u[1]);
        const at: Point = [c[0] + u[0] * going, c[1] + u[1] * going];
        risers.push({ at, rotation: Math.round(angleOf(u) / MICRO) * MICRO, z: below - level.elevation, d: dist(p, at), label: `riser ${String(i + 1)} of ${s.name ?? sid}` });
      }
      below = step.top;
    }
  }
  const best = risers.filter((r) => r.d <= 2 * FT + o.tol).sort((a, b) => a.d - b.d)[0];
  const b = def.box;
  if (best !== undefined) return free(best.at, best.rotation, { box: { min: [-b.max[0], b.min[1], best.z + b.min[2]], max: [0, b.max[1], best.z + b.max[2]] }, hint: `Step light · ${best.label}`, tag: best.label });
  return free(snap(p, o.grid), 0, { hint: 'Step light · on the ground: point at a stair’s riser to set it in one' });
}

/** A beam's label by the plan: "Uplight · 25° flood", "Path light · 6′ ⌀ pool". */
export function beamLabel(kind: ExteriorKind, beam: number, size: number, units: UnitSystem): string {
  const def = EXTERIOR_DEFS[kind];
  if (kind === 'path') return `${def.label} · ${formatLen(Math.round((2 * size) / FT) * FT, units)} ⌀ pool`;
  if (kind === 'string') return `${def.label} · ${formatLen(size, units)} run`;
  return `${def.label} · ${beamWords(beam)}`;
}
