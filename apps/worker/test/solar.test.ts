/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER, type DerivedEnergy } from '@floorspec/engine';
import { estimateSolar, PV_ADVISORY } from '@floorspec/analysis';
import { buildScene, type Scene } from '../src/export/gltf/index.js';
import { renderSceneStill, resolveSky } from '../src/pathtrace/index.js';

/**
 * FLR-T-16.1: the Courtyard House with solar on its roofs (courtyard-house-solar.json, made by
 * make/courtyard-solar.mjs) — the solar assistant's array on the east wing's shed roof, sized to the house's
 * use, and one a person placed on the guest wing's, both on a hybrid inverter beside the panel with a
 * rapid-shutdown initiator on its own circuit. Valid, every array clear of its setbacks, its yearly estimate
 * a range, its modules in the scene every renderer reads in their dark glass, and path-traced from the
 * south-east on a winter morning. FLR_RENDER_DIR, when set, is where the still is written.
 */

type Json = Record<string, unknown>;
const TEXT = readFileSync(new URL('./fixtures/courtyard-house-solar.json', import.meta.url), 'utf8');
const doc = JSON.parse(TEXT) as Json;
let scene: Scene;
beforeAll(async () => {
  scene = await buildScene(doc);
}, 120_000);

const FT = 390_144;
const M = 1_280_000;
const nodes = (s: Scene) => s.levels.flatMap((l) => l.nodes);

describe('the Courtyard House with solar on its roofs', () => {
  it('is valid, both shed roofs carry an array, every array clear and on the inverter, and the inverter on a circuit', () => {
    const r = check(TEXT, OFFICIAL_READER);
    expect(r.valid, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
    expect(r.diagnostics.filter((d) => d.code.startsWith('FS-ENGY'))).toEqual([]);
    const x = r.derived!.extensions!.FS_energy as DerivedEnergy;
    expect(Object.values(x.arrays).map((a) => [a.roof, a.face, a.mount])).toEqual([
      ['RF1', 1, 'flush'],
      ['RF2', 2, 'flush'],
    ]);
    expect(Object.values(x.arrays).every((a) => a.inverter === 'INV1')).toBe(true);
    const circuits = ((doc['extensions'] as Json)['FS_electrical'] as { circuits: Record<string, { loads?: string[] }> }).circuits;
    expect(Object.values(circuits).some((c) => c.loads?.includes('INV1') && c.loads.includes('RS1'))).toBe(true);
  });

  it('estimates each array’s year as a range, never a guarantee', () => {
    const e = estimateSolar(doc as never);
    expect(e.advisory).toBe(PV_ADVISORY);
    const [east, guest] = e.arrays;
    // East-facing 2:12 in Atlanta: about 1,250 kWh a kW; north-facing 3:12, about a fifth less.
    expect(east!.perKw).toBeGreaterThan(1100);
    expect(east!.perKw).toBeLessThan(1400);
    expect(guest!.perKw).toBeLessThan(east!.perKw * 0.9);
    for (const a of e.arrays) {
      expect(a.low).toBeLessThan(a.annual);
      expect(a.high).toBeGreaterThan(a.annual);
      expect(a.monthly).toHaveLength(12);
    }
    // June beats December.
    expect(east!.monthly[5]!).toBeGreaterThan(east!.monthly[11]! * 1.5);
  });

  it('is in the scene as dark glass on the roofs, not as boxes', () => {
    const pv = nodes(scene).filter((n) => n.extension?.name === 'FS_energy' && n.extension.collection === 'pvArrays');
    expect(new Set(pv.map((n) => n.id))).toEqual(new Set(['PV1', 'PV2']));
    const keys = new Set(pv.flatMap((n) => n.primitives.map((p) => scene.materials[p.material]!.key)));
    expect(keys).toEqual(new Set(['role:pvModule']));
  });

  it('path-traces the house with its arrays from the south-east on a winter morning', async () => {
    const skyLight = resolveSky(doc, { sky: 'clear', at: '2026-12-21T10:00' });
    const eye: [number, number, number] = [(120 * FT) / M, 34, (110 * FT) / M];
    const target: [number, number, number] = [(25 * FT) / M, 2, -(32 * FT) / M];
    const dir = process.env['FLR_RENDER_DIR'];
    const big = dir !== undefined && dir !== '';
    const r = await renderSceneStill(scene, {
      skyLight,
      shot: { camera: { eye, target, up: [0, 1, 0], fovY: 42, near: 0.1, label: 'solar' }, inside: false },
      pixels: big ? { width: 1280, height: 800 } : { width: 64, height: 40 },
      samples: big ? 64 : 2,
      denoise: big,
    });
    expect(r.png.length).toBeGreaterThan(100);
    if (big) writeFileSync(`${dir}/solar-pathtraced.png`, r.png);
  }, 1_800_000);
});
