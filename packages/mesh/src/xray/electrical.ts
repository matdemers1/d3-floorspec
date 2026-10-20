/**
 * FS_electrical in X-ray (FLR-T-14.5): each circuit from its panel to its loads, routed along the walls.
 * FS_electrical 0.1 says what a circuit feeds, not where its cable runs, so X-ray routes it by fixed
 * rules:
 *
 * - **The home run** runs inside the walls — in the middle of each wall's core — at a fixed height,
 *   7′6″ above the level's floor (or 4″ under its ceiling, if that is lower): over the doors, and the
 *   height a cable is drilled through the studs.
 * - **The order**: from the panel to the nearest load along the walls, then to the nearest load not yet
 *   reached from there, and so on (ties by ID) — daisy-chained, as a circuit is wired.
 * - **A device on a wall** (a `wallFace` host) gets a drop from the run down (or up) to its box; a
 *   ceiling light, a free or a floor device is reached from the nearest wall: up to the ceiling there
 *   and across to it.
 * - **Another level**: up (or down) through the floor where the run is, to the nearest wall above.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { alongOf, INCH, type WallFrame } from './frames.js';
import { collection, extension, levelOf, locate, num, obj, plan, str, strings, type Located } from './elements.js';
import { atHeight, coreAt, nearestWall, simplify, wallPath, type OnWall } from './routes.js';
import type { P3, XrayPiece, XrayRun } from './types.js';

/** The home run's height above the floor: 7′6″. */
export const RUN_HEIGHT = 90 * INCH;
/** A cable drawn ½″ across, to be seen. */
const CABLE = INCH / 2;
/** A device box: 2″ along the wall, 3″ tall, 2½″ deep. */
const BOX = { along: 2 * INCH, tall: 3 * INCH, deep: (5 * INCH) / 2 };

/** Where a load (or a panel) is reached from: a point on a wall, at a height; and, for one not on a wall, its own point. */
interface Anchor {
  readonly id: string;
  readonly level: string;
  readonly wall: WallFrame;
  readonly t: number;
  readonly z: number;
  /** A device not on a wall: its own point, reached across the ceiling. */
  readonly off: P3 | null;
  /** A device on a wall's face: which face. */
  readonly side: 'left' | 'right' | null;
}

const on = (a: Anchor): OnWall => ({ wall: a.wall.id, t: a.t });

export interface ElectricalResult {
  runs: XrayRun[];
  pieces: XrayPiece[];
  /** Each wall's devices fed by a circuit drawn. */
  devices: Map<string, string[]>;
}

export function electricalRuns(doc: FloorspecDocument, derived: Derived, frames: ReadonlyMap<string, WallFrame>, walls: ReadonlyMap<string, WallFrame[]>): ElectricalResult {
  const out: ElectricalResult = { runs: [], pieces: [], devices: new Map() };
  const data = extension(doc, 'FS_electrical');
  const circuits = obj(data?.['circuits']);
  if (data === undefined || circuits === undefined) return out;
  const elements = new Map(['panels', 'receptacles', 'lights', 'alarms', 'evChargers', 'switches'].flatMap((c) => collection(doc, 'FS_electrical', c)));
  const runAt = (level: string): number => {
    const l = levelOf(doc, level);
    return l.elevation + Math.min(RUN_HEIGHT, l.ceiling - 4 * INCH);
  };

  const anchor = (where: Located): Anchor | null => {
    const host = obj((elements.get(where.id) ?? elementOf(doc, where.id))?.['host']);
    const hosted = host?.['mode'] === 'wallFace' ? frames.get(str(host['wall']) ?? '') : undefined;
    if (hosted !== undefined && !hosted.arc) {
      const t = Math.min(hosted.L, Math.max(0, alongOf(hosted, plan(where.point))));
      return { id: where.id, level: hosted.level, wall: hosted, t, z: where.point[2], off: null, side: host?.['side'] === 'left' ? 'left' : 'right' };
    }
    const near = nearestWall(walls.get(where.level), plan(where.point));
    if (near === null) return null;
    return { id: where.id, level: where.level, wall: frames.get(near.wall)!, t: near.t, z: where.point[2], off: where.point, side: null };
  };
  /** From a device to the run on its wall. */
  const reach = (a: Anchor): P3[] => {
    const c = coreAt(a.wall, a.t);
    const zr = runAt(a.level);
    return a.off === null ? [[c[0], c[1], a.z], [c[0], c[1], zr]] : [a.off, [c[0], c[1], a.off[2]], [c[0], c[1], zr]];
  };
  const level = (l: string) => walls.get(l) ?? [];
  /** How far along the walls from one anchor to another: cross-level legs last. */
  const cost = (a: Anchor, b: Anchor): number => {
    if (a.level !== b.level) {
      const p = coreAt(a.wall, a.t);
      const q = coreAt(b.wall, b.t);
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      return 1e15 + Math.sqrt(dx * dx + dy * dy);
    }
    return wallPath(level(a.level), frames, on(a), on(b))?.length ?? 1e14;
  };
  /** One leg: from a device up to the run, along the walls (through a floor if need be), down to the next. */
  const leg = (a: Anchor, b: Anchor): { points: P3[]; walls: string[] } => {
    const used = new Set<string>([a.wall.id, b.wall.id]);
    const zb = runAt(b.level);
    const points: P3[] = [...reach(a)];
    let from: Anchor = a;
    if (a.level !== b.level) {
      const c = coreAt(a.wall, a.t);
      points.push([c[0], c[1], zb]);
      const near = nearestWall(level(b.level), c);
      if (near === null) return { points: [], walls: [] };
      const f = frames.get(near.wall)!;
      const j = coreAt(f, near.t);
      points.push([j[0], j[1], zb]);
      used.add(f.id);
      from = { ...a, level: b.level, wall: f, t: near.t };
    }
    const path = wallPath(level(b.level), frames, on(from), on(b));
    if (path !== null) {
      points.push(...atHeight(path.points, zb));
      for (const w of path.walls) used.add(w);
    } else {
      const q = coreAt(b.wall, b.t);
      points.push([q[0], q[1], zb]);
    }
    points.push(...reach(b).reverse());
    return { points: simplify(points), walls: [...used] };
  };

  for (const cid of Object.keys(circuits).sort()) {
    const c = obj(circuits[cid]);
    const panelId = str(c?.['panel']);
    if (c === undefined || panelId === undefined) continue;
    const panelAt = locate(derived, panelId);
    const panel = panelAt === null ? null : anchor(panelAt);
    if (panel === null) continue;
    const loads = strings(c['loads'])
      .map((id) => locate(derived, id))
      .filter((l): l is Located => l !== null)
      .map(anchor)
      .filter((a): a is Anchor => a !== null);
    if (loads.length === 0) continue;
    // Daisy-chained: nearest next along the walls, ties by ID.
    const left = [...loads].sort((p, q) => (p.id < q.id ? -1 : 1));
    let at: Anchor = panel;
    const legs: { points: P3[]; level: string }[] = [];
    const used = new Set<string>();
    while (left.length > 0) {
      let best = 0;
      let bestCost = Infinity;
      left.forEach((b, i) => {
        const d = cost(at, b);
        if (d < bestCost) {
          bestCost = d;
          best = i;
        }
      });
      const next = left.splice(best, 1)[0]!;
      const l = leg(at, next);
      if (l.points.length >= 2) legs.push({ points: l.points, level: next.level });
      for (const w of l.walls) used.add(w);
      if (next.off === null && next.side !== null) {
        out.devices.set(next.wall.id, [...(out.devices.get(next.wall.id) ?? []), next.id]);
        out.pieces.push({ system: 'electrical', level: next.level, part: 'box', owner: cid, wall: next.wall.id, shape: 'box', box: boxOf(next) });
      }
      at = next;
    }
    const amps = num(c['breaker']);
    out.runs.push({ id: cid, system: 'electrical', kind: 'circuit', owner: cid, size: 0, ...(amps === undefined ? {} : { amps }), level: panel.level, walls: [...used].sort(), points: legs.flatMap((l) => l.points) });
    // Each leg on the level of the device it reaches: one level shown alone still shows its wiring.
    for (const l of legs) out.pieces.push({ system: 'electrical', level: l.level, part: 'cable', owner: cid, shape: 'tube', points: l.points, diameter: CABLE });
  }
  for (const [w, ids] of out.devices) out.devices.set(w, [...new Set(ids)].sort());
  return out;
}

/** An element of any extension by ID (a load of another extension: a water heater, a furnace). */
function elementOf(doc: FloorspecDocument, id: string): Record<string, unknown> | undefined {
  for (const ext of Object.values(obj(doc.extensions) ?? {})) {
    for (const c of Object.values(obj(obj(ext)?.['collections']) ?? {})) {
      const e = obj(obj(c)?.[id]);
      if (e !== undefined && Object.hasOwn(obj(c)!, id)) return e;
    }
  }
  return undefined;
}

/** A device's box, in its wall behind its face. */
function boxOf(a: Anchor): { o: readonly [number, number]; u: readonly [number, number]; a: readonly [number, number]; b: readonly [number, number]; z: readonly [number, number] } {
  const f = a.wall;
  const b: [number, number] = a.side === 'left' ? [f.left - BOX.deep, f.left] : [f.right, f.right + BOX.deep];
  return { o: f.S, u: f.u, a: [a.t - BOX.along / 2, a.t + BOX.along / 2], b, z: [a.z - BOX.tall / 2, a.z + BOX.tall / 2] };
}
