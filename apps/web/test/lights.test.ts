/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type HouseMesh } from '@floorspec/mesh';
import { readModel, type EditorModel } from '../src/editor/model';
import { ThreeStore } from '../src/editor/three/mode';
import { levelOrder } from '../src/editor/three/parts';
import { EXPOSURE_PER_NIT, lightsOf } from '@floorspec/mesh';
import { GUARANTEED_TEXTURE_UNITS, LIT_EXPOSURE, MAX_LIGHTS, MAX_SPOT_ANGLE, MAX_SHADOWED, OUTSIDE, SCENE_TEXTURE_UNITS, SPILL, shadowBudget, toneMappingExposure, viewLights } from '../src/editor/three/lights';
import { MATERIAL_TEXTURE_UNITS, packOrm } from '../src/editor/three/textures';
import * as THREE from 'three';
import { castsShadow } from '../src/editor/three/parts';

/**
 * FLR-T-12.22: the 3D view's Lights toggle — off until it is turned on, and back — and the lamps it
 * draws for the showcase house's kitchen, laundry, bedroom and porch: where, which way, and which
 * cast the shadows that keep their light in their rooms. FLR-T-13.1: in candela, every room's light
 * before a second in any room, and no luminaire shadowing its own lamp.
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
    // A fan's light kit shines every way; a ceiling light's dome down and out (FLR-T-13.16), within
    // the widest a three.js spot's shadow can be.
    expect(lamps.find((l) => l.id === 'E14')!.kind).toBe('point');
    const e12 = lamps.find((l) => l.id === 'E12')!;
    expect(e12.kind).toBe('spot');
    expect(e12.angle!).toBeLessThanOrEqual(MAX_SPOT_ANGLE);
    expect(e12.angle!).toBeGreaterThan(Math.PI / 3);
    // A pendant throws its light down from under its shade.
    expect(lamps.find((l) => l.id === 'E7')!.kind).toBe('spot');
    for (const l of lamps) {
      expect(l.intensity).toBeGreaterThan(0);
      expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('is photometric: candela from lumens, as three.js\'s own power would set it', () => {
    const lamps = viewLights(model, mesh, { level: 'L1', cutaway: true, order: levelOrder(model) });
    const lumens = new Map(lightsOf(model.view, model.derived!).map((l) => [l.id, l.lumens]));
    const e14 = lamps.find((l) => l.id === 'E14')!;
    // three.js: a point light's power (lm) is 4π times its intensity (cd).
    expect(e14.intensity * 4 * Math.PI).toBeCloseTo(lumens.get('E14')!, 6);
    expect(e14.lumens).toBe(lumens.get('E14'));
    // A spot's candela is its lumens over its cone's solid angle: more than over the whole sphere.
    const e8 = lamps.find((l) => l.id === 'E8')!;
    expect(e8.intensity).toBeGreaterThan(lumens.get('E8')! / (4 * Math.PI));
    // A shadowed lamp is not cut off: inverse-square all the way.
    for (const l of lamps) if (l.shadow) expect(l.distance).toBe(0);
    // The view is exposed within the path tracer's night band, through three.js's ACES.
    expect(LIT_EXPOSURE).toBeGreaterThanOrEqual(EXPOSURE_PER_NIT.night);
    expect(LIT_EXPOSURE).toBeLessThanOrEqual(EXPOSURE_PER_NIT.nightMax);
    expect(toneMappingExposure(LIT_EXPOSURE)).toBeCloseTo(LIT_EXPOSURE * 0.6, 12);
  });

  it('lights every room before a second lamp in any, so no room is dark because its light\'s ID sorts late', () => {
    // Twenty-four more ceiling lights in the laundry (R3), under IDs that sort before every other light.
    const doc = JSON.parse(SHOWCASE) as { extensions: { FS_electrical: { collections: { lights: Record<string, Record<string, unknown>> } } } };
    const lights = doc.extensions.FS_electrical.collections.lights;
    for (let i = 0; i < 24; i++) lights[`A${String(i).padStart(2, '0')}`] = { ...structuredClone(lights['E12']!), host: { mode: 'surface', room: 'R3', surface: 'ceiling', position: [6_400_000 + 32_000 * i, 1_408_000] } };
    const many = readModel('many', JSON.stringify(doc));
    expect(many.valid).toBe(true);
    const lamps = viewLights(many, mesh, { level: 'L1', cutaway: true, order: levelOrder(many) });
    expect(lamps).toHaveLength(MAX_LIGHTS);
    const rooms = new Map(lightsOf(many.view, many.derived!).map((l) => [l.id, l.room]));
    // The kitchen (R1), the bedroom (R2) and the laundry (R3) each have a lamp, and among the first three.
    expect(lamps.slice(0, 3).map((l) => rooms.get(l.id)).sort()).toEqual(['R1', 'R2', 'R3']);
    // The first lamps cast the shadows; the rest are cut off past their rooms, a lantern in none at OUTSIDE.
    expect(lamps.filter((l) => l.shadow)).toHaveLength(MAX_SHADOWED);
    expect(lamps.slice(0, MAX_SHADOWED).every((l) => l.shadow)).toBe(true);
    for (const l of lamps.filter((x) => !x.shadow)) {
      expect(l.distance).toBeGreaterThan(SPILL * 2.7);
      if (rooms.get(l.id) === null) expect(l.distance).toBe(OUTSIDE);
    }
  });

  it('casts no more shadows than a 16-unit GPU has texture units for beside a surface\'s maps (FLR-T-13.17)', () => {
    // The worst case a lit surface's fragment shader samples: its own maps, the sun's shadow, every shadowed lamp's.
    const budget = shadowBudget(16, MATERIAL_TEXTURE_UNITS);
    expect(MATERIAL_TEXTURE_UNITS + SCENE_TEXTURE_UNITS + budget).toBeLessThanOrEqual(16);
    expect(budget).toBe(11);
    // Planned for WebGL 2's guaranteed 16 on a GPU with more, and fewer on one with fewer; never negative.
    expect(shadowBudget(32, MATERIAL_TEXTURE_UNITS)).toBe(budget);
    expect(shadowBudget(GUARANTEED_TEXTURE_UNITS, MATERIAL_TEXTURE_UNITS)).toBe(budget);
    expect(shadowBudget(8, MATERIAL_TEXTURE_UNITS)).toBe(3);
    expect(shadowBudget(4, MATERIAL_TEXTURE_UNITS)).toBe(0);
    expect(shadowBudget(64, 0)).toBe(MAX_SHADOWED);
    const doc = JSON.parse(SHOWCASE) as { extensions: { FS_electrical: { collections: { lights: Record<string, Record<string, unknown>> } } } };
    const lights = doc.extensions.FS_electrical.collections.lights;
    for (let i = 0; i < 24; i++) lights[`A${String(i).padStart(2, '0')}`] = { ...structuredClone(lights['E12']!), host: { mode: 'surface', room: 'R3', surface: 'ceiling', position: [6_400_000 + 32_000 * i, 1_408_000] } };
    const many = readModel('many', JSON.stringify(doc));
    const lamps = viewLights(many, mesh, { level: 'L1', cutaway: true, order: levelOrder(many) }, undefined, budget);
    expect(lamps).toHaveLength(MAX_LIGHTS);
    expect(lamps.filter((l) => l.shadow)).toHaveLength(budget);
    expect(lamps.slice(0, budget).every((l) => l.shadow)).toBe(true);
  });

  it('reads an ORM map\'s roughness, metalness and occlusion through one texture unit (FLR-T-13.17)', () => {
    const fragment = ['#include <roughnessmap_pars_fragment>', '#include <metalnessmap_pars_fragment>', '#include <aomap_pars_fragment>'].join('\n');
    const compile = (occlusion: boolean) => {
      const m = new THREE.MeshStandardMaterial();
      packOrm(m, occlusion);
      const shader = { fragmentShader: fragment, vertexShader: '', uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
      m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
      return { text: shader.fragmentShader, key: m.customProgramCacheKey() };
    };
    const packed = compile(true);
    expect(packed.text).toContain('#include <roughnessmap_pars_fragment>');
    expect(packed.text).toContain('#define metalnessMap roughnessMap');
    expect(packed.text).toContain('#define aoMap roughnessMap');
    expect(packed.text).not.toContain('metalnessmap_pars_fragment');
    expect(packed.text).not.toContain('aomap_pars_fragment');
    // An occlusion map of its own keeps its own sampler; the two programs are cached apart.
    const own = compile(false);
    expect(own.text).toContain('#define metalnessMap roughnessMap');
    expect(own.text).toContain('#include <aomap_pars_fragment>');
    expect(own.key).not.toBe(packed.key);
  });

  it('leaves every piece of a luminaire out of the shadow maps: a fixture never shadows its own lamp', () => {
    const pieces = mesh.parts.filter((p) => p.extension?.name === 'FS_electrical' && p.extension.collection === 'lights');
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.some((p) => p.model?.role !== undefined && p.model.role !== 'lens')).toBe(true);
    for (const p of pieces) expect(castsShadow(p, 'solid')).toBe(false);
    // What is not a luminaire's still does, unless it is glass or a lens.
    const wall = mesh.parts.find((p) => p.kind === 'wall')!;
    expect(castsShadow(wall, 'solid')).toBe(true);
    expect(castsShadow(wall, 'glass')).toBe(false);
  });

  it('draws none for a cutaway below the lights\' level, nor for a model that does not derive', () => {
    const order = new Map([...levelOrder(model), ['B1', -1]]);
    expect(viewLights(model, mesh, { level: 'B1', cutaway: true, order })).toEqual([]);
    expect(viewLights(model, mesh, { level: 'B1', cutaway: false, order })).toHaveLength(9);
    expect(viewLights({ ...model, derived: null }, mesh, { level: 'L1', cutaway: true, order })).toEqual([]);
  });
});
