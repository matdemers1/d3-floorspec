/**
 * The estimate against a box worked by hand, the standard's templates, a document with design
 * options, and its inputs (FLR-T-12.6, FLR-REQ-153).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { check } from '@floorspec/engine';
import {
  ADVISORY,
  AIR,
  BTUH_TO_W,
  describeEstimate,
  estimateEnergy,
  EstimateError,
  inputsOf,
  JULY_21,
  parseInputs,
  TAU,
  UNITS_PER_METRE,
  verticalAt,
  type EnergyInputs,
} from '../src/index.js';

const M = UNITS_PER_METRE;
const TEMPLATES = new URL('../../engine/standard/templates/', import.meta.url);
const template = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`${name}.floorspec.json`, TEMPLATES), 'utf8')) as Record<string, unknown>;

/**
 * A 10 m × 8 m box: four 200 mm walls justified on their outside face and run clockwise, so their
 * left (outside) faces are exactly 10 and 8 m long; 2.5 m tall, a 2.4 m ceiling; one 2 m × 1 m
 * casement window in the south wall. `north` turns true north (Core 1.8).
 */
function box(north = 0): Record<string, unknown> {
  return {
    floorspec: '0.3',
    project: { name: 'Box' },
    site: { trueNorth: north, location: { latitude: 40_000_000, longitude: -75_000_000 } },
    buildings: { B: {} },
    levels: { L: { building: 'B', elevation: 0, height: 2.5 * M, ceilingHeight: 2.4 * M } },
    types: {
      WT: { kind: 'wallType', name: 'Box wall', layers: [{ function: 'core', thickness: 0.2 * M }] },
      WIN: { kind: 'windowType', name: 'Casement', width: 2 * M, height: 1 * M, sill: 1 * M, operation: 'casement' },
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
    rooms: { R: { level: 'L', anchor: [5 * M, 4 * M], name: 'Room', function: 'living' } },
  };
}

const HAND: EnergyInputs = {
  zone: '4A',
  heatingDesign: -10,
  coolingDesign: 32,
  hdd: 2500,
  cdd: 500,
  indoorWinter: 20,
  indoorSummer: 24,
  ach: 0.5,
  assemblies: { 'wall:WT': { u: 0.3 }, ceiling: { u: 0.2 }, slab: { u: 0.9 }, window: { u: 1.5, shgc: 0.5 }, door: { u: 1.2 } },
};

describe('a box worked by hand', () => {
  test('is a valid document', () => {
    expect(check(box()).valid).toBe(true);
  });

  const e = estimateEnergy(box(), { inputs: HAND });
  const row = (key: string) => e.assemblies.find((a) => a.key === key)!;

  test('measures the envelope: outside faces, net wall, ceiling, slab edge, volume', () => {
    // Inside: 9.6 × 7.6 m; outside faces 2 × (10 + 8) × 2.5 m gross, less the 2 m² window.
    expect(e.summary.conditionedArea).toBeCloseTo(9.6 * 7.6, 9);
    expect(e.summary.volume).toBeCloseTo(9.6 * 7.6 * 2.4, 9);
    expect(row('wall:WT').quantity).toBeCloseTo(90 - 2, 9);
    expect(row('ceiling').quantity).toBeCloseTo(72.96, 9);
    expect(row('slab').quantity).toBeCloseTo(36, 9);
    expect(row('window').quantity).toBeCloseTo(2, 9);
    expect(e.assemblies.some((a) => a.key === 'door')).toBe(false);
  });

  test('UA·ΔT design loads and the degree-day year, from the inputs as given', () => {
    const ua = 0.3 * 88 + 0.2 * 72.96 + 0.9 * 36 + 1.5 * 2 + AIR * 0.5 * 9.6 * 7.6 * 2.4;
    expect(e.loads.ua).toBeCloseTo(ua, 9);
    expect(e.loads.heating).toBeCloseTo(ua * 30, 6);
    expect(e.loads.annualHeating).toBeCloseTo((ua * 2500 * 24) / 1000, 6);
    expect(e.loads.annualCooling).toBeCloseTo((ua * 500 * 24) / 1000, 6);
    // Cooling: conduction and air at 8 K, the south window's sun at its peak hour, one person and appliances.
    const air = AIR * 0.5 * 9.6 * 7.6 * 2.4;
    expect(e.loads.coolingParts.conduction).toBeCloseTo((ua - air) * 8, 6);
    expect(e.loads.coolingParts.air).toBeCloseTo(air * 8, 6);
    expect(e.loads.coolingParts.internal).toBeCloseTo((230 + 1200) * BTUH_TO_W, 6);
    const peak = Math.max(...Array.from({ length: 13 }, (_, i) => verticalAt(40, JULY_21, 7 + i, 180, TAU.july)));
    expect(e.loads.coolingParts.solar).toBeCloseTo(2 * 0.5 * peak, 6);
    expect(e.loads.coolingHour).toBe(12);
    expect(e.assemblies.every((a) => a.source === 'yours')).toBe(true);
  });

  test('the façades: the window faces south, every wall its own way', () => {
    const by = Object.fromEntries(e.facades.map((f) => [f.orientation, f]));
    expect(by['S']!.wallArea).toBeCloseTo(25, 9);
    expect(by['N']!.wallArea).toBeCloseTo(25, 9);
    expect(by['E']!.wallArea).toBeCloseTo(20, 9);
    expect(by['S']!.windowArea).toBeCloseTo(2, 9);
    expect(by['S']!.wwr).toBeCloseTo(2 / 25, 9);
    expect(by['S']!.windows).toEqual(['O1']);
    expect(by['S']!.solarJanuary).toBeGreaterThan(by['S']!.solarJuly);
  });

  test('turning true north turns the façades: 90° counter-clockwise puts the window on the west', () => {
    // True north at plan −X: the window's outward normal (plan −Y) faces west.
    const turned = estimateEnergy(box(90_000_000), { inputs: HAND });
    const west = turned.facades.find((f) => f.orientation === 'W')!;
    expect(west.windows).toEqual(['O1']);
    expect(turned.loads.heating).toBeCloseTo(e.loads.heating, 9);
  });

  test('a big west window is a comfort warning that names its room and opening', () => {
    const doc = box(90_000_000);
    (doc['types'] as Record<string, Record<string, unknown>>)['WIN']!['width'] = 4 * M;
    const w = estimateEnergy(doc, { inputs: HAND });
    const note = w.notes.find((n) => n.kind === 'westGlass')!;
    expect(note.severity).toBe('warning');
    expect(note.rooms).toEqual(['R']);
    expect(note.openings).toEqual(['O1']);
    expect(note.title).toBe('West glass in Room may overheat late in the day');
  });

  test('one wall of windows that open is no cross-ventilation; none that opens is said too', () => {
    expect(e.notes.map((n) => n.kind)).toContain('crossVentilation');
    const fixed = box();
    (fixed['types'] as Record<string, Record<string, unknown>>)['WIN']!['operation'] = 'fixed';
    const f = estimateEnergy(fixed, { inputs: HAND });
    expect(f.notes.find((n) => n.kind === 'noOperableWindow')!.openings).toEqual(['O1']);
  });
});

describe('the standard’s templates', () => {
  for (const name of ['ranch', 'two-storey', 'cabin']) {
    test(`${name}: deterministic, advisory, and every number from an input or a listed assumption`, () => {
      const doc = template(name);
      const a = estimateEnergy(doc);
      const b = estimateEnergy(structuredClone(doc));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.advisory).toBe(ADVISORY);
      expect(a.climate.source).toBe('assumed');
      expect(a.assumptions.map((x) => x.key)).toContain('climate');
      for (const r of a.assemblies) {
        expect(r.sourceText.length).toBeGreaterThan(0);
        expect(Number.isFinite(r.ua) && r.ua >= 0).toBe(true);
      }
      expect(a.loads.heating).toBeGreaterThan(0);
      expect(a.loads.cooling).toBeGreaterThan(0);
      const text = describeEstimate(a, 'imperial') + describeEstimate(a, 'metric');
      expect(text).not.toMatch(/complian|meets? (the )?code|passes/i);
      expect(text).toContain(ADVISORY);
    });
  }

  test('ranch: the conditioned area is Core’s net area of every room but the garage', () => {
    const doc = template('ranch');
    const derived = check(doc).derived!;
    const rooms = doc['rooms'] as Record<string, { function?: string }>;
    const net = Object.entries(derived.rooms)
      .filter(([id]) => rooms[id]!.function !== 'garage')
      .reduce((s, [, r]) => s + Number(r.area), 0);
    const e = estimateEnergy(doc);
    expect(e.summary.conditionedArea).toBeCloseTo(net / M / M, 6);
  });

  test('ranch: the slab edge is the outside perimeter less the garage — 56 + 56 + 32 + 10 ft', () => {
    const e = estimateEnergy(template('ranch'));
    expect(e.assemblies.find((a) => a.key === 'slab')!.quantity).toBeCloseTo((154 * 12 * 25.4) / 1000, 6);
    expect(e.assemblies.some((a) => a.kind === 'wallToUnconditioned')).toBe(true);
    // The hall bath is an interior room: no window, so an exhaust fan.
    expect(e.notes.some((n) => n.kind === 'noOperableWindow' && n.rooms.length === 1)).toBe(true);
  });

  test('two-storey: the wall beside the stair well is envelope — the well is heated air', () => {
    const e = estimateEnergy(template('two-storey'));
    const west = e.facades.find((f) => f.orientation === 'W')!;
    const east = e.facades.find((f) => f.orientation === 'E')!;
    expect(west.wallArea).toBeGreaterThan(0.9 * east.wallArea);
  });

  test('the site’s latitude is used, and its absence assumed', () => {
    const doc = template('cabin');
    expect(estimateEnergy(doc).climate.latitudeSource).toBe('site');
    delete (doc['site'] as Record<string, unknown>)['location'];
    const e = estimateEnergy(doc);
    expect(e.climate.latitudeSource).toBe('assumed');
    expect(e.assumptions.find((a) => a.key === 'latitude')!.text).toContain('no location');
  });
});

describe('design options', () => {
  const doc = JSON.parse(readFileSync(new URL('../../engine/standard/conformance/core/0.3/options/001-kitchen-a-and-b/input.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  test('every checked design is estimated, the primary first', () => {
    const e = estimateEnergy(doc, { inputs: HAND });
    expect(e.options!.map((o) => o.tag)).toEqual([null, 'KB']);
    expect(e.options![0]!.heating).toBeCloseTo(e.loads.heating, 9);
  });
  test('a design is estimated on its own view', () => {
    const b = estimateEnergy(doc, { inputs: HAND, design: { KS: 'KB' } });
    expect(b.design).toEqual({ KS: 'KB' });
    expect(() => estimateEnergy(doc, { design: { KS: 'NOPE' } })).toThrow(EstimateError);
  });
});

describe('inputs', () => {
  test('an invalid plan has nothing to estimate', () => {
    expect(() => estimateEnergy({ floorspec: '0.3' })).toThrow(EstimateError);
  });

  test('stored inputs are read from the document’s extras, and bad members are named and skipped', () => {
    const doc = box();
    doc['extras'] = { d3floorspec: { energy: { zone: '5A', hdd: 'lots', ach: 0.6, assemblies: { window: { u: 1.4, shgc: 2 }, bogus: { u: 1 } } } } };
    const { inputs, problems } = inputsOf(doc);
    expect(inputs).toEqual({ zone: '5A', ach: 0.6, assemblies: { window: { u: 1.4 } } });
    expect(problems.map((p) => p.path)).toEqual(['/hdd', '/assemblies/bogus', '/assemblies/window/shgc']);
    const e = estimateEnergy(doc);
    expect(e.climate.zone).toBe('5A');
    expect(e.climate.source).toBe('preset');
    expect(e.problems).toHaveLength(3);
    expect(e.assemblies.find((a) => a.key === 'window')!.value).toBe(1.4);
  });

  test('a preset with one value changed is custom; unknown zones and wrong units are refused', () => {
    expect(estimateEnergy(box(), { inputs: { zone: '6A', heatingDesign: -25 } }).climate.source).toBe('custom');
    expect(parseInputs({ zone: '9Z' }).problems).toHaveLength(1);
    expect(parseInputs({ heatingDesign: 15 * 9 }).problems).toHaveLength(1);
    expect(parseInputs([]).problems).toHaveLength(1);
  });
});
