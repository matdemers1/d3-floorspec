/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type HouseMesh } from '@floorspec/mesh';
import { readModel, type EditorModel } from '../src/editor/model';
import { ThreeStore } from '../src/editor/three/mode';
import { levelOrder } from '../src/editor/three/parts';
import { MAX_SHADOWED, REACH, SHORT, viewLights } from '../src/editor/three/lights';

/**
 * FLR-T-12.22: the 3D view's Lights toggle — off until it is turned on, and back — and the lamps it
 * draws for the showcase house's kitchen, laundry, bedroom and porch: where, which way, and which
 * cast the shadows that keep their light in their rooms.
 */

const SHOWCASE = readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8');

let model: EditorModel;
let mesh: HouseMesh;
beforeAll(async () => {
  model = readModel('showcase', SHOWCASE);
  expect(model.valid).toBe(true);
  mesh = (await loadMesher()).meshDerived(model.view, model.derived!, { origin: [1_280_000, 1_280_000, 0] });
});

describe('the Lights toggle', () => {
  it('is off until turned on, toggles, and tells its listeners', () => {
    const three = new ThreeStore();
    expect(three.get().lights).toBe(false);
    let told = 0;
    three.subscribe(() => { told++; });
    three.toggleLights();
    expect(three.get().lights).toBe(true);
    three.toggleLights(true);
    expect(told).toBe(1);
    three.toggleLights();
    expect(three.get().lights).toBe(false);
    expect(told).toBe(2);
  });
});

describe('the lamps the 3D view draws', () => {
  it('draws every light on the level shown, spots for downlights, relative to the mesh\'s origin', () => {
    const lamps = viewLights(model, mesh, { level: 'L1', cutaway: true, order: levelOrder(model) });
    expect(lamps.map((l) => l.id).sort()).toEqual(['E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E7', 'E8', 'E9']);
    const e8 = lamps.find((l) => l.id === 'E8')!;
    expect(e8.kind).toBe('spot');
    expect(e8.angle!).toBeGreaterThan(0);
    expect(e8.angle!).toBeLessThan(Math.PI / 2);
    expect(e8.penumbra!).toBeGreaterThan(0);
    // E8 is at (1000 mm, 4300 mm), just under the 2700 mm ceiling; the origin is (1000 mm, 1000 mm).
    expect(e8.position[0]).toBeCloseTo(0, 6);
    expect(e8.position[1]).toBeCloseTo(3.3, 6);
    expect(e8.position[2]).toBeGreaterThan(2.65);
    expect(e8.position[2]).toBeLessThan(2.7);
    expect(lamps.find((l) => l.id === 'E12')!.kind).toBe('point');
    for (const l of lamps) {
      expect(l.intensity).toBeGreaterThan(0);
      expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('casts shadows from at most eight lamps of the current level, and keeps the rest short', () => {
    const lamps = viewLights(model, mesh, { level: 'L1', cutaway: true, order: levelOrder(model) });
    const shadowed = lamps.filter((l) => l.shadow);
    expect(shadowed).toHaveLength(MAX_SHADOWED);
    for (const l of lamps) expect(l.distance).toBe(l.shadow ? REACH : SHORT);
  });

  it('draws none for a cutaway below the lights\' level, nor for a model that does not derive', () => {
    const order = new Map([...levelOrder(model), ['B1', -1]]);
    expect(viewLights(model, mesh, { level: 'B1', cutaway: true, order })).toEqual([]);
    expect(viewLights(model, mesh, { level: 'B1', cutaway: false, order })).toHaveLength(9);
    expect(viewLights({ ...model, derived: null }, mesh, { level: 'L1', cutaway: true, order })).toEqual([]);
  });
});
