/**
 * The houses the property tests mesh, other than the conformance suite's: the layout solver's
 * three-bedroom ranch under a hip roof, and generated rectilinear houses. Isomorphic, so the
 * browser project can use them too.
 */
import { evaluate, exteriorOutline } from '@floorspec/engine';
import { BU_PER_FOOT, BU_PER_INCH, SQ_BU_PER_SQ_FT, solve, type Program } from '@floorspec/layout-solver';
import { apply } from '@floorspec/ops';
import fc from 'fast-check';

type Json = Record<string, unknown>;
const FT = BU_PER_FOOT;
const IN = BU_PER_INCH;

/** The layout solver's ranch program (packages/layout-solver/test/programs.ts). */
const sf = (n: number): number => n * SQ_BU_PER_SQ_FT;
const RANCH: Program = {
  items: {
    LIV: { function: 'living', name: 'Living room', targetArea: Math.round(sf(300)), minArea: Math.round(sf(220)) },
    KIT: { function: 'kitchen', name: 'Kitchen', targetArea: Math.round(sf(170)), minArea: Math.round(sf(120)) },
    DIN: { function: 'dining', name: 'Dining', targetArea: Math.round(sf(130)), minArea: Math.round(sf(100)) },
    PBR: { function: 'sleeping', name: 'Primary bedroom', targetArea: Math.round(sf(190)), minArea: Math.round(sf(150)) },
    PBA: { function: 'bath', name: 'Primary bath', targetArea: Math.round(sf(75)), minArea: Math.round(sf(55)) },
    WIC: { function: 'storage', name: 'Walk-in closet', targetArea: Math.round(sf(40)), minArea: Math.round(sf(30)) },
    BED: { function: 'sleeping', name: 'Bedroom', count: 2, targetArea: Math.round(sf(130)), minArea: Math.round(sf(110)) },
    BTH: { function: 'bath', name: 'Hall bath', targetArea: Math.round(sf(50)), minArea: Math.round(sf(40)) },
    LAU: { function: 'laundry', name: 'Laundry', targetArea: Math.round(sf(50)), minArea: Math.round(sf(35)) },
    GAR: { function: 'garage', name: 'Garage', targetArea: Math.round(sf(460)), minArea: Math.round(sf(400)) },
  },
  adjacency: [
    { a: 'KIT', b: 'DIN', kind: 'required', weight: 8 },
    { a: 'PBR', b: 'PBA', kind: 'required', weight: 9 },
    { a: 'PBR', b: 'WIC', kind: 'required', weight: 6 },
    { a: 'LIV', b: 'DIN', kind: 'preferred', weight: 6 },
    { a: 'KIT', b: 'LIV', kind: 'preferred', weight: 4 },
    { a: 'LAU', b: 'GAR', kind: 'preferred', weight: 4 },
    { a: 'GAR', b: 'PBR', kind: 'forbidden', weight: 7 },
    { a: 'GAR', b: 'BED', kind: 'forbidden', weight: 7 },
  ],
};

/**
 * The solver's best three-bedroom ranch, committed with Floorspec Ops, then read as Core 0.3 and
 * given a floor structure, a tray ceiling in the primary bedroom, and an equal-pitch hip roof over
 * its exterior outline with an 18-inch overhang.
 */
export function ranch(): Json {
  const empty: Json = {
    floorspec: '0.2',
    project: { name: 'Ranch' },
    buildings: { B1: { name: 'House' } },
    levels: { L1: { building: 'B1', elevation: 0, height: 9 * FT, name: 'Ground floor' } },
    program: RANCH,
  };
  const best = solve(empty)[0]!;
  const r = apply(empty, { batch: best.batch });
  if (r.status !== 'committed') throw new Error(`the ranch does not commit: ${JSON.stringify(r.diagnostics.slice(0, 3))}`);
  const doc = JSON.parse(r.document) as Json;
  doc['floorspec'] = '0.3';
  const levels = doc['levels'] as Record<string, Json>;
  levels['L1']!['floorThickness'] = 12 * IN;
  levels['L1']!['ceilingHeight'] = 8 * FT;
  const rooms = doc['rooms'] as Record<string, Json>;
  const primary = Object.keys(rooms).find((k) => rooms[k]!['brief'] === 'PBR');
  if (primary) rooms[primary]!['ceiling'] = { kind: 'tray', border: 18 * IN, depth: 8 * IN };
  const outline = exteriorOutline(doc, 'L1')[0]!;
  doc['roofs'] = { RF1: { level: 'L1', footprint: outline, pitch: { rise: 5, run: 12 }, overhang: 18 * IN } };
  const ev = evaluate(doc);
  if (!ev.valid) throw new Error(`the ranch is not valid: ${JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error').slice(0, 3))}`);
  return doc;
}

// ── generated rectilinear houses ────────────────────────────────────────────────

export interface HouseSpec {
  /** Width and depth in 6-inch modules. */
  w: number;
  d: number;
  /** Interior partitions: fractions of the width / depth, as 6-inch module offsets from the west / south wall. */
  xs: number[];
  ys: number[];
  extThick: number;
  floorThickness: number | null;
  openings: { door: boolean; at: number; width: number; sill: number; height: number }[];
  ceiling: 'flat' | 'tray' | 'vault' | 'shed';
  roof: 'hip' | 'gable' | 'shed' | 'flat' | 'none';
  roofThickness: number | null;
  overhang: number;
  pitch: number;
  stair: 'none' | 'straight' | 'l' | 'u';
  slab: boolean;
  rotate: boolean;
}

const M = 6 * IN;

/** A rectilinear house of the given spec, valid by construction. */
export function houseOf(s: HouseSpec): Json {
  const W = s.w * M;
  const D = s.d * M;
  const xs = [0, ...s.xs.map((x) => x * M), W];
  const ys = [0, ...s.ys.map((y) => y * M), D];
  const junctions: Record<string, Json> = {};
  const jid = (i: number, k: number): string => `J${i}_${k}`;
  const walls: Record<string, Json> = {};
  const openings: Record<string, Json> = {};
  let oi = 0;
  const addWall = (a: string, b: string, len: number, exterior: boolean): void => {
    const id = `W${Object.keys(walls).length + 1}`;
    walls[id] = { level: 'L1', start: a, end: b, type: exterior ? 'EXT' : 'INT' };
    const o = s.openings[Object.keys(walls).length % Math.max(1, s.openings.length)];
    if (!o) return;
    const door = o.door || !exterior;
    const width = Math.min(o.width * IN, len - 2 * FT);
    if (width < 18 * IN) return;
    const room = len - width - 2 * FT;
    const offset = FT + Math.floor((room * o.at) / 1000 / IN) * IN;
    const sill = door ? 0 : o.sill * IN;
    const height = door ? 80 * IN : o.height * IN;
    openings[`O${++oi}`] = { wall: id, offset, width, height, sill };
  };
  // Junctions at every crossing of a partition line with another line or the exterior.
  for (let i = 0; i < xs.length; i++) for (let k = 0; k < ys.length; k++) junctions[jid(i, k)] = { level: 'L1', position: [xs[i]!, ys[k]!] };
  // Walls along every grid line: the exterior counter-clockwise, then the partitions.
  for (let i = 0; i + 1 < xs.length; i++) addWall(jid(i, 0), jid(i + 1, 0), xs[i + 1]! - xs[i]!, true);
  for (let k = 0; k + 1 < ys.length; k++) addWall(jid(xs.length - 1, k), jid(xs.length - 1, k + 1), ys[k + 1]! - ys[k]!, true);
  for (let i = xs.length - 1; i > 0; i--) addWall(jid(i, ys.length - 1), jid(i - 1, ys.length - 1), xs[i]! - xs[i - 1]!, true);
  for (let k = ys.length - 1; k > 0; k--) addWall(jid(0, k), jid(0, k - 1), ys[k]! - ys[k - 1]!, true);
  for (let i = 1; i + 1 < xs.length; i++) for (let k = 0; k + 1 < ys.length; k++) addWall(jid(i, k), jid(i, k + 1), ys[k + 1]! - ys[k]!, false);
  for (let k = 1; k + 1 < ys.length; k++) for (let i = 0; i + 1 < xs.length; i++) addWall(jid(i, k), jid(i + 1, k), xs[i + 1]! - xs[i]!, false);
  // Junctions no wall meets (none here: every grid point is on two lines) would be invalid; drop any.
  const used = new Set(Object.values(walls).flatMap((w) => [w['start'] as string, w['end'] as string]));
  for (const j of Object.keys(junctions)) if (!used.has(j)) Reflect.deleteProperty(junctions, j);

  const rooms: Record<string, Json> = {};
  let ri = 0;
  for (let i = 0; i + 1 < xs.length; i++)
    for (let k = 0; k + 1 < ys.length; k++) {
      const cx = (xs[i]! + xs[i + 1]!) / 2;
      const cy = (ys[k]! + ys[k + 1]!) / 2;
      const room: Json = { level: 'L1', anchor: [Math.round(cx), Math.round(cy)], function: 'living' };
      const first = ri === 0;
      if (first && s.ceiling === 'tray') room['ceiling'] = { kind: 'tray', border: 12 * IN, depth: 8 * IN };
      if (first && (s.ceiling === 'vault' || s.ceiling === 'shed'))
        room['ceiling'] = {
          kind: 'vaulted',
          height: 10 * FT,
          ridge: s.ceiling === 'vault' ? [[xs[i]!, Math.round(cy)], [xs[i + 1]!, Math.round(cy)]] : [[xs[i]!, ys[k + 1]!], [xs[i + 1]!, ys[k + 1]!]],
          pitch: { rise: 2, run: 12 },
          ...(s.ceiling === 'shed' && { slopes: 'right' }),
        };
      rooms[`R${++ri}`] = room;
    }

  const T = s.extThick * IN;
  const doc: Json = {
    floorspec: '0.3',
    project: { name: 'Generated' },
    buildings: { B1: {} },
    levels: {
      L1: { building: 'B1', elevation: 0, height: 9 * FT, ceilingHeight: 8 * FT, ...(s.floorThickness !== null && { floorThickness: s.floorThickness * IN }) },
      L2: { building: 'B1', elevation: 9 * FT, height: 8 * FT },
    },
    types: {
      EXT: { kind: 'wallType', layers: [{ thickness: T, function: 'core' }] },
      INT: { kind: 'wallType', layers: [{ thickness: Math.round(4.5 * IN), function: 'core' }] },
    },
    junctions,
    walls,
    openings,
    rooms,
  };
  // The roof's footprint: the exterior faces of the exterior walls (centred on the grid lines).
  const h = T / 2;
  const fp = [[-h, -h], [W + h, -h], [W + h, D + h], [-h, D + h]];
  if (s.roof !== 'none') {
    const edges: Record<string, Json> =
      s.roof === 'gable' ? { '1': { gable: true }, '3': { gable: true } } : s.roof === 'shed' ? { '1': { gable: true }, '2': { gable: true }, '3': { gable: true } } : {};
    doc['roofs'] = {
      RF: {
        level: 'L1',
        footprint: fp,
        overhang: s.overhang * IN,
        ...(s.roof !== 'flat' && { pitch: { rise: s.pitch, run: 12 } }),
        ...(Object.keys(edges).length && { edges }),
        ...(s.roofThickness !== null && { thickness: s.roofThickness * IN }),
      },
    };
  }
  if (s.slab) doc['slabs'] = { PATIO: { level: 'L1', boundary: [[W + h, 0], [W + h + 10 * FT, 0], [W + h + 10 * FT, 12 * FT], [W + h, 12 * FT]], thickness: 4 * IN, offset: -6 * IN, purpose: 'patio' } };
  if (s.stair !== 'none') {
    const form = s.stair === 'l' ? { kind: 'lShaped', turn: 'left', risersBeforeTurn: 7 } : s.stair === 'u' ? { kind: 'uShaped', turn: 'left', risersBeforeTurn: 7, gap: 4 * IN } : undefined;
    doc['stairs'] = {
      ST: { level: 'L1', to: 'L2', position: [Math.round(2 * FT), Math.round(2 * FT)], rotation: s.rotate ? 30_000_000 : 0, width: 36 * IN, tread: 10 * IN, maxRiser: Math.round(7.75 * IN), ...(form && { form }) },
    };
  }
  return doc;
}

const modules = (lo: number, hi: number): fc.Arbitrary<number> => fc.integer({ min: lo, max: hi });

/** Partition offsets: up to two, at least 12 feet (24 modules) from the walls and each other. */
const partitions = (n: number): fc.Arbitrary<number[]> =>
  fc.uniqueArray(fc.integer({ min: 16, max: Math.max(16, n - 16) }), { maxLength: 2 }).map((a) => {
    const s = [...a].sort((x, y) => x - y);
    const out: number[] = [];
    for (const x of s) if (x >= 16 && x <= n - 16 && (out.length === 0 || x - out[out.length - 1]! >= 16)) out.push(x);
    return out;
  });

export const houseSpec: fc.Arbitrary<HouseSpec> = fc
  .record({ w: modules(36, 120), d: modules(32, 80) })
  .chain(({ w, d }) =>
    fc.record({
      w: fc.constant(w),
      d: fc.constant(d),
      xs: partitions(w),
      ys: partitions(d),
      extThick: fc.constantFrom(6, 8),
      floorThickness: fc.option(fc.constantFrom(10, 12), { nil: null, freq: 2 }),
      openings: fc.array(
        fc.record({ door: fc.boolean(), at: fc.integer({ min: 0, max: 1000 }), width: fc.integer({ min: 24, max: 72 }), sill: fc.integer({ min: 18, max: 40 }), height: fc.integer({ min: 24, max: 60 }) }),
        { maxLength: 6 },
      ),
      ceiling: fc.constantFrom('flat', 'tray', 'vault', 'shed'),
      roof: fc.constantFrom('hip', 'gable', 'shed', 'flat', 'none'),
      roofThickness: fc.option(fc.constantFrom(8, 10), { nil: null, freq: 2 }),
      overhang: fc.integer({ min: 0, max: 24 }),
      pitch: fc.integer({ min: 3, max: 12 }),
      stair: fc.constantFrom('none', 'straight', 'l', 'u'),
      slab: fc.boolean(),
      rotate: fc.boolean(),
    }),
  );
