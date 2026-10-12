/**
 * FLR-T-12.22: what each FS_electrical luminaire shines — `lightsOf` over the showcase house, whose
 * kitchen has a pendant, two recessed downlights on a switch, a track and an under-cabinet strip,
 * whose laundry has a ceiling light on a dimmer and a sconce, and whose outside wall has a lantern.
 */
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, type Derived, type FloorspecDocument } from '@floorspec/engine';
import showcase from './fixtures/showcase.floorspec.json' with { type: 'json' };
import { DEFAULT_LUMENS, EXPOSURE_PER_NIT, kelvinColor, lightsOf, LUMENS_PER_WATT, WHITE_BALANCE } from '../src/index.js';
import { ceilingDome } from '../src/models/electrical.js';

type Json = Record<string, unknown>;
const MM = 1280;

function derive(input: object): { doc: FloorspecDocument; derived: Derived } {
  const ev = evaluate(input, OFFICIAL_READER);
  if (!ev.valid) throw new Error(ev.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('\n'));
  return { doc: (ev.view ?? ev.document)!, derived: deriveEvaluation(ev) };
}

const inside = (p: readonly [number, number], ring: readonly (readonly [number, number])[]): boolean => {
  let k = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) k = !k;
  }
  return k;
};

describe('lightsOf', () => {
  const { doc, derived } = derive(structuredClone(showcase));
  const lights = lightsOf(doc, derived);
  const byId = new Map(lights.map((l) => [l.id, l]));

  it('gives every light its kind, room and switches, in ID order', () => {
    expect(lights.map((l) => l.id)).toEqual(['E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E7', 'E8', 'E9']);
    expect(Object.fromEntries(lights.map((l) => [l.id, l.fixture]))).toEqual({ E7: 'pendant', E8: 'recessed', E9: 'recessed', E10: 'underCabinet', E11: 'track', E12: 'ceiling', E13: 'wall', E14: 'fan', E15: 'exterior' });
    expect(byId.get('E8')!.room).toBe('R1');
    expect(byId.get('E12')!.room).toBe('R3');
    expect(byId.get('E15')!.room).toBeNull();
    expect(byId.get('E8')!.switches).toEqual(['E5']);
    expect(byId.get('E12')!.switches).toEqual(['E6']);
    expect(byId.get('E7')!.switches).toEqual([]);
  });

  it('puts a hung light under its box, a ceiling light in its dome, a downlight under its trim, a wall light in front of its face', () => {
    for (const l of lights) expect(l.position.every(Number.isInteger)).toBe(true);
    const f = (id: string) => derived.fallbacks![id]!;
    const centre = (id: string) => [f(id).footprint.reduce((s, p) => s + p[0], 0) / 4, f(id).footprint.reduce((s, p) => s + p[1], 0) / 4];
    for (const id of ['E7', 'E14', 'E10', 'E11']) {
      const l = byId.get(id)!;
      expect(l.position.slice(0, 2)).toEqual(centre(id).map(Math.round));
      expect(l.position[2]).toBeLessThan(f(id).bottom);
      expect(l.position[2]).toBeGreaterThan(f(id).bottom - 50 * MM);
    }
    // FLR-T-13.16: a ceiling light's lamp is inside the dome the model draws — under its canopy and
    // above the dome's crown — not in the air under the fitting, where the box's bottom is.
    const e12 = byId.get('E12')!;
    const sides = [0, 1].map((k) => Math.hypot(f('E12').footprint[k + 1]![0] - f('E12').footprint[k]![0], f('E12').footprint[k + 1]![1] - f('E12').footprint[k]![1]));
    const dome = ceilingDome(sides[0]!, sides[1]!, f('E12').top - f('E12').bottom);
    expect(e12.position.slice(0, 2)).toEqual(centre('E12').map(Math.round));
    expect(e12.position[2] + e12.radius).toBeLessThanOrEqual(f('E12').top - dome.canopy);
    expect(e12.position[2] - e12.radius).toBeGreaterThanOrEqual(f('E12').top - dome.canopy - dome.depth);
    expect(e12.position[2]).toBeGreaterThan(f('E12').bottom);
    // A recessed light: just under the ceiling, not in the air at its box's bottom.
    const e8 = byId.get('E8')!;
    expect(e8.position[2]).toBeLessThan(f('E8').top);
    expect(e8.position[2]).toBeGreaterThan(f('E8').top - 20 * MM);
    expect(e8.position[2] + e8.radius).toBeLessThan(f('E8').top);
    // A sconce and a lantern: at mid-height, outside their boxes' footprints, on the room's side (or outside).
    for (const id of ['E13', 'E15']) {
      const l = byId.get(id)!;
      expect(l.position[2]).toBe(Math.round((f(id).bottom + f(id).top) / 2));
      expect(inside([l.position[0], l.position[1]], f(id).footprint)).toBe(false);
    }
    expect(inside([byId.get('E13')!.position[0], byId.get('E13')!.position[1]], derived.rooms['R3']!.outer)).toBe(true);
    for (const id of ['R1', 'R2', 'R3']) expect(inside([byId.get('E15')!.position[0], byId.get('E15')!.position[1]], derived.rooms[id]!.outer)).toBe(false);
  });

  it('points downlights, track, under-cabinet strips, pendants and ceiling lights down a cone, and lets the rest shine every way', () => {
    for (const l of lights) {
      const spot = ['recessed', 'track', 'underCabinet', 'pendant', 'ceiling'].includes(l.fixture);
      expect(l.direction).toBe(spot ? 'down' : 'omni');
      if (spot) expect(l.cone!.inner).toBeGreaterThan(l.cone!.outer);
      else expect(l.cone).toBeUndefined();
    }
    // FLR-T-13.16: a ceiling light's dome lights down and out, a little past the horizontal so it
    // grazes the ceiling around it, and nothing straight up into its canopy.
    const dome = byId.get('E12')!.cone!;
    expect(dome.inner).toBeGreaterThan(0);
    expect(dome.outer).toBeLessThan(0);
    expect(dome.outer).toBeGreaterThan(-0.5);
  });

  it('gives a typical lamp\'s lumens, or 90 a watt, warm white inside and a little cooler outside', () => {
    for (const l of lights) expect(l.lumens).toBe(DEFAULT_LUMENS[l.fixture]);
    expect(byId.get('E15')!.kelvin).toBe(3000);
    expect(byId.get('E12')!.kelvin).toBe(2700);
    const lum = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    for (const k of [2000, 2700, 3000, 4000, 9000]) expect(lum(kelvinColor(k))).toBeCloseTo(1, 9);
    // Warmer is redder.
    expect(kelvinColor(2700)[2] / kelvinColor(2700)[0]).toBeLessThan(kelvinColor(4000)[2] / kelvinColor(4000)[0]);
    // FLR-T-13.1: the camera is balanced for warm-white lamps — 3000 K is white, 2700 K warm white, not orange.
    for (const c of kelvinColor(WHITE_BALANCE)) expect(c).toBeCloseTo(1, 9);
    const warm = kelvinColor(2700);
    expect(warm[2] / warm[0]).toBeGreaterThan(0.55);
    expect(warm[2] / warm[0]).toBeLessThan(0.8);
    const watts = structuredClone(showcase) as unknown as Json;
    ((watts['extensions'] as Json)['FS_electrical'] as { collections: { lights: Record<string, Json> } }).collections.lights['E12']!['watts'] = 15;
    const w = derive(watts);
    expect(lightsOf(w.doc, w.derived).find((l) => l.id === 'E12')!.lumens).toBe(15 * LUMENS_PER_WATT);
  });

  it('calibrates its defaults and the views\' exposure in photometric units (FLR-T-13.1)', () => {
    // A bedroom's one ceiling light, a downlight, a pendant, a sconce and a lantern: typical lamps.
    expect(DEFAULT_LUMENS).toMatchObject({ ceiling: 1500, recessed: 800, pendant: 800, wall: 400, exterior: 600 });
    // Night: a white wall (ρ 0.8) at 200 lux is ρE/π cd/m², given about 0.5 — a light tone, under the shoulder.
    const wall = (lux: number) => (0.8 * lux) / Math.PI;
    expect(wall(200) * EXPOSURE_PER_NIT.night).toBeGreaterThan(0.4);
    expect(wall(200) * EXPOSURE_PER_NIT.night).toBeLessThan(0.6);
    // Opened up two stops at most: a 50-lux bedroom reads as a 200-lux room does.
    expect(EXPOSURE_PER_NIT.nightMax / EXPOSURE_PER_NIT.night).toBe(4);
    // Day: a white wall in full sun (about 80 000 lux on it) is given about 0.3; a daylit room metered up to seven stops more.
    expect(wall(80_000) * EXPOSURE_PER_NIT.day).toBeGreaterThan(0.25);
    expect(wall(80_000) * EXPOSURE_PER_NIT.day).toBeLessThan(0.4);
    expect(wall(1000) * EXPOSURE_PER_NIT.dayMax).toBeGreaterThan(0.4);
  });

  it('is the same every time', () => {
    const again = derive(structuredClone(showcase));
    expect(lightsOf(again.doc, again.derived)).toEqual(lights);
  });
});
