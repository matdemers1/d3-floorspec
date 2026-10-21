/**
 * FLR-T-16.4: the thermal envelope worked by hand — a 2×6 wall with batts and 25% framing, a rated
 * window, and a box room's heat loss part by part; the thermal library; stations by location.
 */
import { describe, expect, test } from 'vitest';
import { check, OFFICIAL_EXTENSION_NAMES, OFFICIAL_EXTENSIONS, type FloorspecDocument } from '@floorspec/engine';
import {
  AIR,
  F_IP_TO_SI,
  estimateEnergy,
  nearestStation,
  parallelU,
  resolveClimate,
  R_SI_TO_IP,
  rText,
  slabF,
  STATIONS,
  THERMAL_LIBRARY,
  thermalData,
  thermalMatch,
  thermalView,
  U_IP_TO_SI,
  UNITS_PER_METRE,
  wallTypeThermal,
  type EnergyInputs,
} from '../src/index.js';

const M = UNITS_PER_METRE;
const IN = 32512;
const T = 'FS_thermal';
const mat = (name: string, thermal: Record<string, number>) => ({ name, color: '#808080', extensions: { [T]: thermal } });

/**
 * The box of estimate.test.ts — 10 m × 8 m, 2.5 m tall, a 2.4 m ceiling, one 2 m × 1 m window in the
 * south wall — with FS_thermal: a 2×6 wall of ½″ gypsum, 5½″ fibreglass batts between SPF studs at 25%
 * and 7/16″ OSB; the window rated U 1.70 and SHGC 0.25; the floor's edge insulated to R-10.
 */
function box(): Record<string, unknown> {
  return {
    floorspec: '0.4',
    project: { name: 'Thermal box' },
    site: { location: { latitude: 40_000_000, longitude: -75_000_000 } },
    buildings: { B: {} },
    levels: { L: { building: 'B', elevation: 0, height: 2.5 * M, ceilingHeight: 2.4 * M } },
    materials: {
      GYP: mat('Gypsum', { conductivity: 160, density: 800, specificHeat: 1090 }),
      BATT: mat('Batt', { conductivity: 40, density: 12, specificHeat: 840 }),
      OSB: mat('OSB', { conductivity: 100, density: 650, specificHeat: 1880 }),
      SPF: mat('SPF', { conductivity: 120, density: 450, specificHeat: 1630 }),
    },
    types: {
      WT: {
        kind: 'wallType',
        name: '2x6 wall',
        layers: [
          { function: 'substrate', thickness: (7 * IN) / 16, material: 'OSB' },
          { function: 'core', thickness: (11 * IN) / 2, material: 'BATT' },
          { function: 'finish', thickness: IN / 2, material: 'GYP' },
        ],
        extensions: { [T]: { framing: { material: 'SPF', fraction: 250 } } },
      },
      WIN: { kind: 'windowType', name: 'Casement', width: 2 * M, height: 1 * M, sill: 1 * M, operation: 'casement', extensions: { [T]: { uFactor: 1700, shgc: 250 } } },
    },
    junctions: {
      J1: { level: 'L', position: [0, 0] },
      J2: { level: 'L', position: [0, 8 * M] },
      J3: { level: 'L', position: [10 * M, 8 * M] },
      J4: { level: 'L', position: [10 * M, 0] },
    },
    walls: {
      WW: { level: 'L', start: 'J1', end: 'J2', type: 'WT', justification: 'exteriorFace' },
      WN: { level: 'L', start: 'J2', end: 'J3', type: 'WT', justification: 'exteriorFace' },
      WE: { level: 'L', start: 'J3', end: 'J4', type: 'WT', justification: 'exteriorFace' },
      WS: { level: 'L', start: 'J4', end: 'J1', type: 'WT', justification: 'exteriorFace' },
    },
    openings: { O1: { wall: 'WS', offset: 4 * M, fill: 'WIN', name: 'South window' } },
    rooms: { R: { level: 'L', anchor: [5 * M, 4 * M], name: 'Room', function: 'living', extensions: { [T]: { floor: { edgeResistance: 1761 } } } } },
    extensionsUsed: { [T]: '0.1.0' },
  };
}

const CLIMATE: EnergyInputs = { zone: '4A', heatingDesign: -10, coolingDesign: 32, hdd: 2500, cdd: 500, indoorWinter: 20, indoorSummer: 24, ach: 0.5 };

// By hand (FS_thermal 3.1): OSB 25 × 14224 / (32 × 100) = 111.125 → 111; batts 25 × 178816 / (32 × 40) = 3492.5 → 3492
// (ties to even); gypsum 25 × 16256 / (32 × 160) = 79.375 → 79; studs 25 × 178816 / (32 × 120) = 1164.17 → 1164.
const R_CLEAR = (111 + 3492 + 79) / 1000;
const R_FRAMED = (111 + 1164 + 79) / 1000;
const FILMS = 0.12 + 0.03;
const U_WALL = 0.75 / (FILMS + R_CLEAR) + 0.25 / (FILMS + R_FRAMED);

describe('a 2×6 wall with batts and framing, by hand', () => {
  test('is a valid FS_thermal document', () => {
    const r = check(box(), { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS });
    expect(r.valid).toBe(true);
    const x = (r.derived!.extensions as { FS_thermal: { wallTypes: Record<string, { clear: { resistance: number }; framed: { resistance: number } }> } }).FS_thermal;
    expect(x.wallTypes['WT']!.clear.resistance).toBe(3682);
    expect(x.wallTypes['WT']!.framed.resistance).toBe(1354);
  });

  test('R and U through the cavity and the studs, in parallel, with ASHRAE’s films', () => {
    const a = wallTypeThermal(thermalView(box() as unknown as FloorspecDocument), 'WT')!;
    expect(a.rClear).toBeCloseTo(R_CLEAR, 12);
    expect(a.rFramed).toBeCloseTo(R_FRAMED, 12);
    expect(a.u).toBeCloseTo(U_WALL, 12);
    expect(a.u).toBeCloseTo(parallelU(R_CLEAR, R_FRAMED, 0.25, { inside: 0.12, outside: 0.03 }), 12);
    // About R-15.7 overall in inch-pounds; the cavity alone R-21.8.
    expect(a.rEffective! * R_SI_TO_IP).toBeCloseTo(15.69, 1);
    expect(rText(a.rEffective!)).toBe('R-16');
    expect(a.framing).toMatchObject({ source: 'document', fraction: 0.25 });
    expect(a.fromDocument).toBe(true);
    expect(a.layers.map((l) => l.r)).toEqual([0.111, 3.492, 0.079]);
    // Thermal mass: the paths' heat capacity weighted by area.
    const clear = a.layers.reduce((s, l) => s + l.heatCapacity!, 0);
    expect(a.heatCapacity).toBeGreaterThan(clear);
  });

  test('a wall toward a garage has an inside film on both faces', () => {
    const a = wallTypeThermal(thermalView(box() as unknown as FloorspecDocument), 'WT', 'unconditioned')!;
    expect(a.u).toBeCloseTo(0.75 / (0.24 + R_CLEAR) + 0.25 / (0.24 + R_FRAMED), 12);
  });

  test('a wall type that states no framing, its core a cavity of the library, is assumed 25% softwood and says so', () => {
    const d = box();
    const types = d['types'] as Record<string, Record<string, unknown>>;
    delete types['WT']!['extensions'];
    (types['WT']!['layers'] as { material: string }[])[1]!.material = 'wood-stud-framing-insulated';
    (d['materials'] as Record<string, unknown>)['wood-stud-framing-insulated'] = { name: 'Studs, insulated cavities' };
    const a = wallTypeThermal(thermalView(d as unknown as FloorspecDocument), 'WT')!;
    expect(a.framing).toMatchObject({ source: 'assumed', fraction: 0.25 });
    expect(a.layers[1]!.source).toBe('library');
    expect(a.layers[1]!.libraryItem).toBe('fibreglass-batt');
    expect(a.fromDocument).toBe(false);
  });
});

describe('a box room’s heat loss, part by part', () => {
  const e = estimateEnergy(box(), { inputs: CLIMATE });
  const dT = 30;
  const room = e.rooms[0]!;
  const part = (k: string) => room.heatingParts.find((p) => p.kind === k)!;

  test('the document’s own assemblies are used', () => {
    expect(e.thermal).toBe(true);
    const wall = e.assemblies.find((a) => a.key === 'wall:WT')!;
    expect(wall.source).toBe('document');
    expect(wall.value).toBeCloseTo(U_WALL, 12);
    const win = e.assemblies.find((a) => a.key === 'window')!;
    expect(win.value).toBeCloseTo(1.7, 12);
    expect(win.shgc).toBeCloseTo(0.25, 12);
    expect(win.source).toBe('document');
  });

  test('walls, the window, the slab edge, the ceiling and the air, each U·A·ΔT', () => {
    expect(part('walls').watts).toBeCloseTo(U_WALL * 88 * dT, 6);
    expect(part('windows').watts).toBeCloseTo(1.7 * 2 * dT, 6);
    // R-10 at the edge: F-0.54 (ASHRAE 90.1 Appendix A), along the 36 m of outside wall.
    expect(slabF(1.761)).toBeCloseTo(0.54 * F_IP_TO_SI, 2);
    expect(part('slab').watts).toBeCloseTo(slabF(1.761) * 36 * dT, 6);
    expect(part('ceiling').watts).toBeCloseTo(0.024 * U_IP_TO_SI * e.summary.conditionedArea * dT, 6);
    expect(part('air').watts).toBeCloseTo(AIR * 0.5 * e.summary.volume * dT, 6);
    expect(room.heating).toBeCloseTo(e.loads.heating, 6);
    expect(room.name).toBe('Room');
  });

  test('cooling: conduction, air, the sun at the room’s peak hour, a person and the appliances', () => {
    const kinds = room.coolingParts.map((p) => p.kind).sort();
    expect(kinds).toEqual(['air', 'appliances', 'ceiling', 'people', 'slab', 'sun', 'walls', 'windows']);
    expect(room.cooling).toBeCloseTo(e.loads.cooling, 6);
  });

  test('the map’s surfaces: the window loses most per square foot, the walls least', () => {
    const win = e.surfaces.find((s) => s.element === 'O1')!;
    const wall = e.surfaces.find((s) => s.element === 'WN')!;
    expect(win.flux).toBeCloseTo(1.7 * dT, 9);
    expect(win.band).toBe('high');
    expect(wall.flux).toBeCloseTo(U_WALL * dT, 9);
    expect(wall.perArea).toBeLessThan(win.perArea / 4);
    expect(e.shares.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
  });

  test('a better window shows its effect', () => {
    const d = box();
    ((d['types'] as Record<string, { extensions: Record<string, Record<string, number>> }>)['WIN']!.extensions[T]!)['uFactor'] = 800;
    const better = estimateEnergy(d, { inputs: CLIMATE });
    expect(e.loads.heating - better.loads.heating).toBeCloseTo((1.7 - 0.8) * 2 * dT, 6);
  });

  test('a document that does not use FS_thermal keeps the zone’s typical values', () => {
    const d = JSON.parse(JSON.stringify(box()), (k, v: unknown) => (k === 'extensions' || k === 'extensionsUsed' ? undefined : v)) as Record<string, unknown>;
    const plain = estimateEnergy(d, { inputs: CLIMATE });
    expect(plain.thermal).toBe(false);
    expect(plain.assemblies.find((a) => a.key === 'wall:WT')!.source).toBe('typical');
    expect(plain.envelope).toEqual([]);
  });

  test('deterministic, and never a verdict', () => {
    expect(JSON.stringify(estimateEnergy(box(), { inputs: CLIMATE }))).toBe(JSON.stringify(e));
    expect(JSON.stringify(e)).not.toMatch(/complian|meets? (the )?code|passes/i);
  });
});

describe('the climate of the site', () => {
  test('Atlanta’s Courtyard House is estimated for Atlanta, zone 3A', () => {
    const c = resolveClimate({}, 33.749, -84.388);
    expect(c.source).toBe('site');
    expect(c.zone).toBe('3A');
    expect(c.station!.city).toBe('Atlanta, GA');
    expect(c.station!.km).toBeLessThan(30);
    expect(c.label).toContain('Atlanta');
  });

  test('a site far from every station is assumed, as before', () => {
    const c = resolveClimate({}, 39.8283, -98.5795);
    expect(c.source).toBe('assumed');
    expect(nearestStation(39.8283, -98.5795).km).toBeGreaterThan(250);
  });

  test('a zone the user chose wins over the station', () => {
    expect(resolveClimate({ zone: '6A' }, 33.749, -84.388).zone).toBe('6A');
  });

  test('every preset city is a station with the preset’s zone', () => {
    for (const s of STATIONS) expect(s.zone).toMatch(/^[1-8][ABC]?$/);
  });
});

describe('the thermal library', () => {
  test('every item states a conductivity or a resistance, never both, within FS_thermal’s ranges, and cites its source', () => {
    for (const i of THERMAL_LIBRARY) {
      expect((i.conductivity === undefined) !== (i.resistance === undefined)).toBe(true);
      expect(i.density).toBeGreaterThanOrEqual(1);
      expect(i.specificHeat).toBeGreaterThanOrEqual(1);
      const d = thermalData(i);
      expect(String(d['citation'])).toMatch(/CC0 1\.0/);
      expect(Object.values(d).every((v) => typeof v === 'string' || Number.isInteger(v))).toBe(true);
    }
  });

  test('a material is matched by its ID, then its library item', () => {
    expect(thermalMatch('gypsum-board', {})!.id).toBe('gypsum-board');
    expect(thermalMatch('M7', { source: { item: 'lap-siding' } })!.id).toBe('fibre-cement');
    expect(thermalMatch('M8', { source: { item: 'paint-eggshell' } })).toBeUndefined();
  });
});
