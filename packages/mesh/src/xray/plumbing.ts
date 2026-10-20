/**
 * FS_plumbing in X-ray (FLR-T-14.5). FS_plumbing 0.1 records what drains where and which water heater
 * feeds which fixture, not where a pipe runs (its §1: "Pipe routing is not in this version"), so X-ray
 * routes each connection by fixed rules — a drawing of the design's connections, not shop drawings:
 *
 * - **Where a fixture connects**: the wall nearest its placement (its back, 13.4), at its projection
 *   on that wall, in the middle of the wall's core; a fixture more than 2′ from every wall connects
 *   through the floor under itself.
 * - **Supply**: cold and hot each from the water heater — its `hotFrom`, else the first by ID (the
 *   cold service is taken to enter where the heater stands) — down the heater's wall, under the floor
 *   (3″ below the level's elevation) east–west then north–south, and up the fixture's wall to its
 *   stub-out height (by fixture: 21″ for a sink, 8″ for a water closet, 32″ for a tub's valve …).
 *   Cold runs 1½″ to one side of the connection, hot to the other.
 * - **Drain**: down the fixture's wall from its drain height (in the floor for a water closet, a tub or
 *   a shower), under the floor (9″ down) to its stack — or to the floor drain it drains to, which drains
 *   to its stack in turn. A water heater's relief drains the same way.
 * - **Vent**: each fixture's vent rises in its wall from the drain to the level's ceiling.
 * - **A stack** stands at its first water closet's connection (by ID, on its lowest level), else its
 *   first connected element's, from 12″ under its lowest level to the top of its highest.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { INCH, type V2, type WallFrame } from './frames.js';
import { collection, extension, levelOf, levelsUp, locate, obj, plan, str, strings, type Json, type Located } from './elements.js';
import { coreAt, nearestWall, squareRoute, simplify } from './routes.js';
import type { P3, XrayPiece, XrayRun } from './types.js';

/** Stub-out and drain heights above the floor, inches; a null drain is in the floor. */
const HEIGHTS: Readonly<Record<string, { supply: number; drain: number | null }>> = {
  waterCloset: { supply: 8, drain: null },
  bidet: { supply: 8, drain: null },
  urinal: { supply: 44, drain: 21 },
  lavatory: { supply: 21, drain: 18 },
  kitchenSink: { supply: 21, drain: 18 },
  barSink: { supply: 21, drain: 18 },
  laundryTub: { supply: 21, drain: 18 },
  mopSink: { supply: 36, drain: null },
  bathtub: { supply: 32, drain: null },
  bathtubShower: { supply: 32, drain: null },
  shower: { supply: 48, drain: null },
  clothesWasher: { supply: 42, drain: 36 },
  dishwasher: { supply: 6, drain: 18 },
  hoseBibb: { supply: 18, drain: null },
  iceMaker: { supply: 24, drain: null },
};
const DEFAULT_HEIGHTS = { supply: 21, drain: 18 };

/** Farther than this from every wall, a fixture connects through the floor under itself. */
const REACH = 24 * INCH;
/** Cold and hot, either side of a fixture's connection. */
const SPREAD = (3 * INCH) / 2;
const SUPPLY_DEPTH = 3 * INCH;
const DRAIN_DEPTH = 9 * INCH;

/** Outside diameters drawn for nominal sizes: a pipe's nominal size plus ½″ (near enough for a view). */
export const outside = (nominal: number): number => nominal + INCH / 2;

/** Where an element connects: on a wall (its core, `t` along it) or through the floor at its own point. */
interface Connection {
  readonly level: string;
  readonly wall: WallFrame | null;
  readonly t: number;
  /** The connection's point on the plan: in the wall's core, or the element's own. */
  readonly at: V2;
}

export interface PlumbingResult {
  runs: XrayRun[];
  pieces: XrayPiece[];
}

export function plumbingRuns(doc: FloorspecDocument, derived: Derived, frames: ReadonlyMap<string, WallFrame>, walls: ReadonlyMap<string, WallFrame[]>): PlumbingResult {
  const out: PlumbingResult = { runs: [], pieces: [] };
  const data = extension(doc, 'FS_plumbing');
  if (data === undefined) return out;
  const fixtures = collection(doc, 'FS_plumbing', 'fixtures');
  const heaters = collection(doc, 'FS_plumbing', 'waterHeaters');
  const drains = collection(doc, 'FS_plumbing', 'drains');
  const stacks = obj(data['stacks']) ?? {};
  const kindOf = new Map<string, Json>([...fixtures, ...heaters, ...drains]);

  const connect = (where: Located, wall = true): Connection => {
    const near = wall ? nearestWall(walls.get(where.level), plan(where.point)) : null;
    if (near === null || near.distance > REACH) return { level: where.level, wall: null, t: 0, at: plan(where.point) };
    const f = frames.get(near.wall)!;
    return { level: where.level, wall: f, t: near.t, at: coreAt(f, near.t) };
  };
  const along = (c: Connection, d: number): V2 => (c.wall === null ? [c.at[0] + d, c.at[1] + d] : coreAt(c.wall, Math.min(c.wall.L, Math.max(0, c.t + d))));
  const add = (run: Omit<XrayRun, 'points' | 'walls'> & { walls: (WallFrame | null)[] }, points: P3[], diameter: number, dashed: boolean) => {
    const pts = simplify(points);
    if (pts.length < 2) return;
    const walls = [...new Set(run.walls.flatMap((w) => (w === null ? [] : [w.id])))].sort();
    out.runs.push({ ...run, walls, points: pts });
    out.pieces.push(dashed ? { system: run.system, level: run.level, part: run.kind, owner: run.id, shape: 'tube', points: pts, diameter, dashed: true } : { system: run.system, level: run.level, part: run.kind, owner: run.id, shape: 'tube', points: pts, diameter });
  };

  // ── Stacks: where each stands, and its riser.
  const stackAt = new Map<string, { at: V2; wall: WallFrame | null; levels: string[] }>();
  const order = levelsUp(doc);
  for (const id of Object.keys(stacks).sort()) {
    const s = obj(stacks[id]);
    if (s === undefined || s['stack'] === 'vent') continue;
    const levels = strings(s['levels']).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const lowest = levels[0];
    if (lowest === undefined) continue;
    const via = new Set(drains.filter(([, d]) => d['drain'] === id).map(([d]) => d));
    const connected = [...fixtures, ...heaters, ...drains].filter(([, e]) => e['drain'] === id || (typeof e['drain'] === 'string' && via.has(e['drain']))).map(([e]) => e).sort();
    const placed = connected.map((e) => locate(derived, e)).filter((l): l is Located => l !== null);
    const onLowest = placed.filter((l) => l.level === lowest);
    const closet = onLowest.find((l) => kindOf.get(l.id)?.['fixture'] === 'waterCloset');
    const at = closet ?? onLowest[0] ?? placed[0];
    if (at === undefined) continue;
    const c = connect(at);
    stackAt.set(id, { at: c.at, wall: c.wall, levels });
    const highest = levels[levels.length - 1]!;
    const bottom = levelOf(doc, lowest).elevation - 12 * INCH;
    const top = levelOf(doc, highest).elevation + levelOf(doc, highest).height;
    const size = typeof s['size'] === 'number' ? s['size'] : 3 * INCH;
    add({ id, system: 'drain', kind: 'stack', owner: id, size, level: lowest, walls: [c.wall] }, [[c.at[0], c.at[1], bottom], [c.at[0], c.at[1], top]], outside(size), true);
  }

  // ── Supply: cold and hot from the water heater to each fixture.
  const heaterIds = heaters.map(([id]) => id);
  const firstHeater = heaterIds.find((id) => locate(derived, id) !== null);
  for (const [id, f] of fixtures) {
    // The cold service is taken to enter where the heater stands: both start there.
    const from = str(f['hotFrom']) ?? firstHeater;
    const where = locate(derived, id);
    if (where === null) continue;
    const kind = str(f['fixture']) ?? '';
    const h = HEIGHTS[kind] ?? DEFAULT_HEIGHTS;
    const c = connect(where);
    const floor = levelOf(doc, where.level).elevation;
    const supply = strings(f['supply']);
    const hotFrom = str(f['hotFrom']);
    const temps: ('cold' | 'hot')[] = [];
    if (supply.length === 0 || supply.includes('cold')) temps.push('cold');
    if (supply.includes('hot') || hotFrom !== undefined) temps.push('hot');
    for (const temp of temps) {
      const heater = from === undefined ? null : locate(derived, from);
      if (heater === null) continue;
      const hc = connect(heater);
      const side = temp === 'cold' ? -SPREAD : SPREAD;
      const a = along(hc, side);
      const b = along(c, side);
      const fz = floor - SUPPLY_DEPTH;
      const points: P3[] = [[a[0], a[1], heater.top - 3 * INCH], [a[0], a[1], fz], ...squareRoute(a, b, fz), [b[0], b[1], floor + h.supply * INCH]];
      add({ id: `${id}:${temp}`, system: 'supply', kind: temp, owner: id, size: INCH / 2, level: where.level, walls: [c.wall, hc.wall] }, points, outside(INCH / 2), false);
    }
  }

  // ── Drains and vents: each fixture, water heater and drain to what it drains to.
  for (const [id, e] of [...fixtures, ...heaters, ...drains].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
    const to = str(e['drain']);
    if (to === undefined) continue;
    const where = locate(derived, id);
    if (where === null) continue;
    const isFixture = typeof e['fixture'] === 'string';
    const isDrain = typeof e['receptor'] === 'string';
    const kind = str(e['fixture']) ?? '';
    const h = HEIGHTS[kind] ?? DEFAULT_HEIGHTS;
    const c = connect(where, !isDrain);
    const floor = levelOf(doc, where.level).elevation;
    const start = isFixture && h.drain !== null ? floor + h.drain * INCH : isDrain ? where.point[2] : floor;
    const fz = floor - DRAIN_DEPTH;
    const stack = stackAt.get(to);
    const drain = stack === undefined ? locate(derived, to) : null;
    const target: V2 | null = stack?.at ?? (drain === null ? null : plan(drain.point));
    if (target === null) continue;
    const size = kind === 'waterCloset' ? 3 * INCH : isFixture || isDrain ? 2 * INCH : INCH;
    const points: P3[] = [[c.at[0], c.at[1], start], [c.at[0], c.at[1], fz], ...squareRoute(c.at, target, fz)];
    if (drain !== null) points.push([target[0], target[1], drain.point[2]]);
    add({ id: `${id}:drain`, system: 'drain', kind: 'drain', owner: id, size, level: where.level, walls: [c.wall] }, points, outside(size), true);
    if (isFixture && c.wall !== null) {
      const l = levelOf(doc, where.level);
      add({ id: `${id}:vent`, system: 'drain', kind: 'vent', owner: id, size: (3 * INCH) / 2, level: where.level, walls: [c.wall] }, [[c.at[0], c.at[1], start], [c.at[0], c.at[1], l.elevation + l.ceiling]], outside((3 * INCH) / 2), true);
    }
  }
  return out;
}
