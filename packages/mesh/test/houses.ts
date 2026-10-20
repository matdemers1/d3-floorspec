/**
 * The houses the property tests mesh, other than the conformance suite's: the layout solver's
 * three-bedroom ranch under a hip roof, generated rectilinear houses, and the showcase with its
 * sinks set across two counters each. Isomorphic, so the
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

/**
 * The showcase with its kitchen sink S1 moved to straddle the base cabinet X4 and a second one, X20,
 * where the dishwasher was — in the box a real house gave it, 600 mm deep like the cabinets, its top
 * at theirs — and its vanity V1 split into two, V1 and V9, the basin S3 across where they meet
 * (FLR-T-12.31). `sinkAt` moves S1 along the wall.
 */
export function straddling(showcase: Json, sinkAt = 3_724_800): Json {
  type Collections = { collections: Record<string, Record<string, Json>> };
  const d = structuredClone(showcase);
  const exts = d['extensions'] as Record<string, Collections>;
  const casework = exts['FS_furniture']!.collections['casework']!;
  delete exts['FS_furniture']!.collections['appliances']!['X5'];
  const x4 = casework['X4']!;
  casework['X20'] = { ...structuredClone(x4), host: { ...(x4['host'] as Json), offset: 4_108_800 } };
  const s1 = exts['FS_plumbing']!.collections['fixtures']!['S1']!;
  s1['fallback'] = { level: 'L1', box: { min: [0, -416_000, 896_000], max: [768_000, 416_000, 1_152_000] } };
  s1['host'] = { ...(s1['host'] as Json), offset: sinkAt, height: 0 };
  const v1 = casework['V1']!;
  casework['V1'] = { ...v1, fallback: { ...(v1['fallback'] as Json), box: { min: [0, -288_000, 0], max: [704_000, 288_000, 1_088_000] } }, host: { ...(v1['host'] as Json), offset: 2_656_000 } };
  casework['V9'] = { ...structuredClone(casework['V1']), host: { ...(v1['host'] as Json), offset: 3_232_000 } };
  return d;
}

/**
 * The showcase with appliances described twice (FLR-T-12.34), and the near misses that are not: its
 * dishwasher X5 names X5-P, an FS_plumbing `dishwasher` fixture in its box; a washer WM1 names WM1-P,
 * a `clothesWasher` fixture in its box, and WM1-B, a hose bibb inside it; a cooktop CT1 and an
 * FS_mechanical gas `cooktop` CT1-G share a box and name nothing. And a `clothesWasher` fixture
 * WM2-P with no appliance; a washer WM3 naming WM3-P, which stands a metre and a half away; a gas
 * dryer GD1 overlapping the washer WM1, named by nothing.
 */
export function paired(showcase: Json): Json {
  type Collections = { collections: Record<string, Record<string, Json>> };
  const d = structuredClone(showcase);
  const exts = d['extensions'] as Record<string, Collections>;
  const appliances = exts['FS_furniture']!.collections['appliances']!;
  const fixtures = exts['FS_plumbing']!.collections['fixtures']!;
  const gas = exts['FS_mechanical']!.collections['gasAppliances']!;
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Json => ({ level: 'L1', box: { min: [x0, y0, z0], max: [x1, y1, z1] } });
  const x5 = appliances['X5']!;
  x5['connections'] = ['X5-P'];
  fixtures['X5-P'] = { fixture: 'dishwasher', supply: ['hot'], fallback: structuredClone(x5['fallback']), host: structuredClone(x5['host']) };
  // Out in the yard, south of the house, unhosted: each box in the level's frame. An appliance
  // carries a model and a symbol (FS_furniture 3.1): the dishwasher's do.
  const washer = (x: number): Json => box(x, -2_048_000, 0, x + 832_000, -1_164_800, 1_088_000);
  const { asset, symbol } = x5['fallback'] as Json;
  const item = (fallback: Json): Json => ({ ...fallback, asset, symbol });
  appliances['WM1'] = { category: 'washer', connections: ['WM1-P', 'WM1-B'], fallback: item(washer(5_120_000)) };
  fixtures['WM1-P'] = { fixture: 'clothesWasher', fallback: washer(5_120_000) };
  fixtures['WM1-B'] = { fixture: 'hoseBibb', fallback: box(5_120_000, -1_664_000, 512_000, 5_248_000, -1_536_000, 640_000) };
  gas['GD1'] = { appliance: 'dryer', fuel: 'naturalGas', fallback: washer(5_632_000) };
  appliances['CT1'] = { category: 'cooktop', fallback: item(box(7_040_000, -2_048_000, 896_000, 7_680_000, -1_536_000, 960_000)) };
  gas['CT1-G'] = { appliance: 'cooktop', fuel: 'naturalGas', fallback: box(7_040_000, -2_048_000, 896_000, 7_680_000, -1_536_000, 960_000) };
  fixtures['WM2-P'] = { fixture: 'clothesWasher', fallback: washer(8_320_000) };
  appliances['WM3'] = { category: 'washer', connections: ['WM3-P'], fallback: item(washer(9_600_000)) };
  fixtures['WM3-P'] = { fixture: 'clothesWasher', fallback: washer(11_520_000) };
  return d;
}

/**
 * A house with an opening of every operation (FLR-T-13.8): a 20 × 10 m box of two rooms either side
 * of a partition. Its west and north walls hold a window of every window operation, a twin casement
 * with grilles and a glass wall down to the floor; its north and east walls French doors, a garage
 * door, a patio slider and a swing door; the partition a barn door, a pocket door (its pocket
 * beyond its end jamb), a bifold, a double-acting door, a cased opening and a swing door hung at its
 * end, opening to its left.
 */
export function joinery(): Json {
  const MM = 1_280;
  const at = (x: number, y: number): [number, number] => [x * MM, y * MM];
  const door = (name: string, operation: string, w: number, h: number): Json => ({ kind: 'doorType', name, operation, width: w * MM, height: h * MM });
  const win = (name: string, operation: string, w: number, h: number, sill: number): Json => ({ kind: 'windowType', name, operation, width: w * MM, height: h * MM, sill: sill * MM });
  const opening = (wall: string, offset: number, fill: string, more: Json = {}): Json => ({ wall, offset: offset * MM, fill, ...more });
  const doc: Json = {
    floorspec: '0.3',
    project: { name: 'Joinery' },
    buildings: { H: { name: 'House' } },
    levels: { L1: { building: 'H', elevation: 0, height: 3_000 * MM, name: 'Ground floor' } },
    junctions: {
      A: { level: 'L1', position: at(0, 0) },
      D: { level: 'L1', position: at(0, 10_000) },
      N: { level: 'L1', position: at(10_000, 10_000), join: { kind: 'butt', through: ['WN1', 'WN2'] } },
      C: { level: 'L1', position: at(20_000, 10_000) },
      B: { level: 'L1', position: at(20_000, 0) },
      S: { level: 'L1', position: at(10_000, 0), join: { kind: 'butt', through: ['WS2', 'WS1'] } },
    },
    walls: {
      WW: { level: 'L1', start: 'A', end: 'D', type: 'EXT' },
      WN1: { level: 'L1', start: 'D', end: 'N', type: 'EXT' },
      WN2: { level: 'L1', start: 'N', end: 'C', type: 'EXT' },
      WE: { level: 'L1', start: 'C', end: 'B', type: 'EXT' },
      WS2: { level: 'L1', start: 'B', end: 'S', type: 'EXT' },
      WS1: { level: 'L1', start: 'S', end: 'A', type: 'EXT' },
      WP: { level: 'L1', start: 'S', end: 'N', type: 'INT' },
    },
    rooms: {
      R1: { level: 'L1', anchor: at(5_000, 5_000), name: 'West room', function: 'living' },
      R2: { level: 'L1', anchor: at(15_000, 5_000), name: 'East room', function: 'garage' },
    },
    types: {
      EXT: { kind: 'wallType', name: 'Exterior wall', layers: [{ thickness: 19 * MM, function: 'finish' }, { thickness: 140 * MM, function: 'core' }, { thickness: 13 * MM, function: 'finish' }] },
      INT: { kind: 'wallType', name: 'Partition', layers: [{ thickness: 13 * MM, function: 'finish' }, { thickness: 89 * MM, function: 'core' }, { thickness: 13 * MM, function: 'finish' }] },
      DSW: door('Swing door', 'swing', 914, 2_032),
      DFR: door('Double swing doors', 'doubleSwing', 1_829, 2_032),
      DDA: door('Double-acting door', 'doubleActing', 914, 2_032),
      DPK: door('Pocket door', 'pocket', 813, 2_032),
      DBP: door('Bypass sliding doors', 'bypassSlide', 1_829, 2_032),
      DBN: door('Barn door', 'surfaceSlide', 914, 2_032),
      DBF: door('Bifold doors', 'bifold', 1_219, 2_032),
      DOH: door('Overhead garage door', 'overhead', 2_743, 2_134),
      DCS: door('Cased opening', 'cased', 1_000, 2_100),
      WFX: win('Fixed window', 'fixed', 1_219, 1_219, 762),
      WCS: win('Casement window', 'casement', 610, 1_219, 762),
      WAW: win('Awning window', 'awning', 914, 610, 1_219),
      WHP: win('Hopper window', 'hopper', 610, 610, 1_219),
      WSH: win('Single-hung window', 'singleHung', 914, 1_524, 610),
      WDH: win('Double-hung window', 'doubleHung', 914, 1_524, 610),
      WHS: win('Horizontal sliding window', 'horizontalSlider', 1_219, 914, 914),
      WTT: win('Tilt-turn window', 'tiltTurn', 762, 1_219, 762),
      WPV: win('Pivot window', 'pivot', 762, 1_219, 762),
      WTG: win('Twin casement window with grilles', 'casement', 1_524, 1_219, 762),
      WGL: win('Glass wall', 'fixed', 1_829, 2_400, 0),
    },
    openings: {
      O1: opening('WW', 500, 'WFX'),
      O2: opening('WW', 2_200, 'WCS'),
      O3: opening('WW', 3_300, 'WAW'),
      O4: opening('WW', 4_700, 'WHP'),
      O5: opening('WW', 5_800, 'WSH'),
      O6: opening('WW', 7_200, 'WDH'),
      O7: opening('WW', 8_500, 'WHS'),
      O8: opening('WN1', 1_000, 'WTT'),
      O9: opening('WN1', 2_500, 'WPV'),
      O10: opening('WN1', 4_000, 'WTG'),
      O11: opening('WN1', 6_500, 'WGL'),
      O12: opening('WN2', 1_000, 'DFR'),
      O13: opening('WN2', 4_000, 'DOH'),
      O14: opening('WE', 1_000, 'DBP'),
      O15: opening('WE', 4_000, 'DSW', { hinge: 'start', swing: 'right' }),
      O16: opening('WS2', 3_000, 'WDH'),
      O17: opening('WP', 1_300, 'DBN'),
      O18: opening('WP', 2_800, 'DPK', { hinge: 'end' }),
      O19: opening('WP', 4_700, 'DBF'),
      O20: opening('WP', 6_000, 'DDA'),
      O21: opening('WP', 7_100, 'DCS', { width: 600 * MM }),
      O22: opening('WP', 8_300, 'DSW', { hinge: 'end', swing: 'left' }),
    },
  };
  const ev = evaluate(doc);
  if (!ev.valid) throw new Error(`the joinery house is not valid: ${JSON.stringify(ev.diagnostics.filter((d) => d.severity === 'error').slice(0, 3))}`);
  return doc;
}

/**
 * FLR-T-14.5's X-ray house: one 16′ × 12′ room of 2x6 exterior walls (insulated cores, OSB sheathing)
 * with a 3′ window in its south wall and a door in its west wall; a heat-pump water heater, a
 * lavatory and a water closet on a stack; a panel on the west wall feeding two receptacles on the east
 * wall and a ceiling light; a furnace with a ceiling supply register and a return grille.
 */
export function xrayHouse(): Json {
  const at = (x: number, y: number): [number, number] => [x * IN, y * IN];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ min: [x0 * IN, y0 * IN, z0 * IN], max: [x1 * IN, y1 * IN, z1 * IN] });
  const onWall = (wall: string, offset: number, height: number, side: 'left' | 'right' = 'left') => ({ mode: 'wallFace', wall, offset: offset * IN, height: height * IN, side });
  const onFloor = (x: number, y: number, rotation: number) => ({ mode: 'surface', room: 'R1', surface: 'floor', position: at(x, y), rotation });
  return {
    floorspec: '0.4',
    project: { name: 'X-ray' },
    buildings: { H: { name: 'House' } },
    levels: { L1: { building: 'H', elevation: 0, height: 108 * IN, ceilingHeight: 96 * IN, name: 'Ground floor' } },
    junctions: {
      A: { level: 'L1', position: at(0, 0) },
      B: { level: 'L1', position: at(192, 0) },
      C: { level: 'L1', position: at(192, 144) },
      D: { level: 'L1', position: at(0, 144) },
    },
    walls: {
      WS: { level: 'L1', start: 'A', end: 'B', type: 'EXT' },
      WE: { level: 'L1', start: 'B', end: 'C', type: 'EXT' },
      WN: { level: 'L1', start: 'C', end: 'D', type: 'EXT' },
      WW: { level: 'L1', start: 'D', end: 'A', type: 'EXT' },
    },
    rooms: { R1: { level: 'L1', anchor: at(96, 72), name: 'Room', function: 'bath' } },
    materials: {
      studs: { name: 'Wood stud framing, insulated cavities', color: '#dcc28c' },
      osb: { name: 'OSB sheathing', color: '#c09a5b' },
      gyp: { name: 'Gypsum board', color: '#efede8' },
    },
    types: {
      EXT: {
        kind: 'wallType',
        name: '2x6 exterior',
        layers: [
          { thickness: 7 * IN / 16, function: 'substrate', material: 'osb' },
          { thickness: 11 * IN / 2, function: 'core', material: 'studs' },
          { thickness: IN / 2, function: 'finish', material: 'gyp' },
        ],
      },
      WIN: { kind: 'windowType', name: 'Window', width: 36 * IN, height: 48 * IN, sill: 36 * IN },
      DOOR: { kind: 'doorType', name: 'Door', width: 36 * IN, height: 80 * IN },
    },
    openings: { O1: { wall: 'WS', offset: 60 * IN, fill: 'WIN' }, O2: { wall: 'WW', offset: 72 * IN, fill: 'DOOR', sill: 0 } },
    extensionsUsed: { FS_electrical: '0.1.0', FS_plumbing: '0.1.0', FS_mechanical: '0.1.0' },
    extensions: {
      FS_plumbing: {
        stacks: { K1: { levels: ['L1'], name: 'Main stack' } },
        collections: {
          waterHeaters: { WH: { heater: 'heatPump', energy: 'electric', fallback: { level: 'L1', box: box(-12, -12, 0, 12, 12, 60) }, host: onFloor(168, 120, -90_000_000) } },
          fixtures: {
            LAV: { fixture: 'lavatory', supply: ['cold', 'hot'], hotFrom: 'WH', drain: 'K1', fallback: { level: 'L1', box: box(0, -10, 30, 20, 10, 34) }, host: onFloor(100, 3.5, 90_000_000) },
            WC: { fixture: 'waterCloset', supply: ['cold'], drain: 'K1', fallback: { level: 'L1', box: box(0, -9, 0, 28, 9, 30) }, host: onFloor(140, 3.5, 90_000_000) },
          },
        },
      },
      FS_electrical: {
        collections: {
          panels: { P1: { volts: [120, 240], rating: 200, spaces: 40, fallback: { level: 'L1', box: box(0, -7, -16, 4, 7, 16) }, host: onWall('WW', 36, 60) } },
          receptacles: {
            RA: { fallback: { level: 'L1', box: box(0, -1.5, -2, 1, 1.5, 2) }, host: onWall('WE', 36, 16) },
            RB: { fallback: { level: 'L1', box: box(0, -1.5, -2, 1, 1.5, 2) }, host: onWall('WE', 108, 16) },
          },
          lights: { LT: { fixture: 'ceiling', fallback: { level: 'L1', box: box(-6, -6, -4, 6, 6, 0) }, host: { mode: 'surface', room: 'R1', surface: 'ceiling', position: at(96, 72), rotation: 0 } } },
        },
        circuits: { C1: { panel: 'P1', breaker: 20, volts: 120, loads: ['RA', 'RB', 'LT'], name: 'Room' } },
      },
      FS_mechanical: {
        collections: {
          equipment: { F1: { equipment: 'furnace', fallback: { level: 'L1', box: box(-12, -12, 0, 12, 12, 48) }, host: onFloor(24, 120, 0) } },
          terminals: {
            S1: { terminal: 'supply', equipment: 'F1', fallback: { level: 'L1', box: box(-6, -6, -1, 6, 6, 0) }, host: { mode: 'surface', room: 'R1', surface: 'ceiling', position: at(120, 72), rotation: 0 } },
            T1: { terminal: 'return', equipment: 'F1', fallback: { level: 'L1', box: box(-8, -8, 0, 8, 8, 1) }, host: onFloor(60, 120, 0) },
          },
        },
      },
    },
  };
}
