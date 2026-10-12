/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_OFF, loadMesher, sceneNamed, settingOf, type HouseMesh } from '@floorspec/mesh';
import { readModel, type EditorModel } from '../src/editor/model';
import { ThreeStore } from '../src/editor/three/mode';
import { levelOrder } from '../src/editor/three/parts';
import { viewLights } from '../src/editor/three/lights';
import { cannotSave, census, controlsOf, deleteScene, houseLights, nameProblem, nextSceneId, overwriteScene, panelScenes, renameScene, saveNewScene, switchHint, unchanged } from '../src/editor/three/lighting/lighting';

/**
 * FLR-T-13.12: lighting design in the editor — the showcase house (a kitchen switch E5 on its two
 * downlights E8 and E9, a laundry dimmer E6 on its ceiling light E12) with an "Evening" scene: what
 * a click on a switch flips, the scenes the panel offers, the lamps the 3D view draws for a scene, and
 * the Ops that save, rename and delete one.
 */

type Json = Record<string, unknown>;
const SHOWCASE = JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

function withEvening(): Json {
  const doc = structuredClone(SHOWCASE);
  (doc['extensionsUsed'] as Json)['FS_lighting'] = '0.1.0';
  (doc['extensions'] as Json)['FS_lighting'] = { scenes: { LS1: { name: 'Evening', on: { E7: { output: 40, cct: 2400 }, E15: {} } } } };
  return doc;
}

let model: EditorModel;
let plain: EditorModel;
let mesh: HouseMesh;
beforeAll(async () => {
  model = readModel('showcase', JSON.stringify(withEvening()));
  plain = readModel('showcase', JSON.stringify(SHOWCASE));
  expect(model.valid).toBe(true);
  mesh = (await loadMesher()).meshDerived(model.view, model.derived!, { origin: [1_280_000, 1_280_000, 0] });
});

describe('switches in the 3D view', () => {
  it('knows what a switch controls, and that other things control nothing', () => {
    const lights = houseLights(model);
    expect(controlsOf(model, 'E5', lights)).toEqual(['E8', 'E9']);
    expect(controlsOf(model, 'E6', lights)).toEqual(['E12']);
    // A light, a wall and a receptacle are not switches.
    expect(controlsOf(model, 'E8', lights)).toBeNull();
    expect(controlsOf(model, 'W1', lights)).toBeNull();
  });

  it('flips exactly the lights a switch controls — from the dark, from All on, and back', () => {
    const three = new ThreeStore();
    const ids = houseLights(model).map((l) => l.id);
    // Lights off: the house is dark, and the switch lights its two downlights alone.
    three.flipSwitch(['E8', 'E9'], ids);
    expect(three.get().lights).toBe(true);
    expect(viewLights(model, mesh, { level: 'L1', cutaway: true, order: levelOrder(model) }, three.get().lighting).map((l) => l.id).sort()).toEqual(['E8', 'E9']);
    three.flipSwitch(['E8', 'E9'], ids);
    expect(three.get().lighting).toEqual(ALL_OFF);
    // From "All on": its lights go off, every other stays on.
    three.chooseScene(panelScenes(model)[0]!);
    three.flipSwitch(['E12'], ids);
    const after = viewLights(model, mesh, { level: 'L1', cutaway: true, order: levelOrder(model) }, three.get().lighting).map((l) => l.id).sort();
    expect(after).toEqual(ids.filter((id) => id !== 'E12').sort());
    expect(switchHint(three.get().lighting, true, ['E12'])).toBe('1 light · click to turn on');
    expect(switchHint(three.get().lighting, true, ['E8', 'E9'])).toBe('2 lights · click to turn off');
  });

  it('dims a light in the view: the lamp gives its share of its lumens', () => {
    const three = new ThreeStore();
    const ids = houseLights(model).map((l) => l.id);
    three.chooseScene(panelScenes(model)[0]!);
    three.setLight('E12', { output: 25 }, ids);
    const order = levelOrder(model);
    const full = viewLights(model, mesh, { level: 'L1', cutaway: true, order }).find((l) => l.id === 'E12')!;
    const dim = viewLights(model, mesh, { level: 'L1', cutaway: true, order }, three.get().lighting).find((l) => l.id === 'E12')!;
    expect(dim.intensity).toBeCloseTo(full.intensity / 4, 1);
    expect(census(three.get().lighting, houseLights(model))).toEqual({ on: 9, dimmed: 1, total: 9 });
  });
});

describe('scenes in the Lighting panel', () => {
  it('offers All on, the document’s scenes and Off; Evening draws what it turns on', () => {
    expect(panelScenes(model).map((s) => s.name)).toEqual(['All on', 'Evening', 'Off']);
    const evening = panelScenes(model)[1]!;
    expect(viewLights(model, mesh, { level: 'L1', cutaway: true, order: levelOrder(model) }, evening.lighting).map((l) => l.id).sort()).toEqual(['E15', 'E7']);
    expect(unchanged(evening.lighting, evening, houseLights(model))).toBe(true);
  });

  it('saves the view’s lighting as a new scene, declaring FS_lighting where it is not', () => {
    const lights = houseLights(plain);
    const lighting = { on: { E7: { output: 40, cct: 2400 }, E8: {}, E15: {} } };
    const { id, batch } = saveNewScene(plain, 'Dinner', lighting, lights);
    expect(id).toBe('LS1');
    expect(batch).toEqual([
      { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_lighting', value: '0.1.0' },
      { op: 'setProperty', id: '$document', path: '/extensions/FS_lighting/scenes/LS1', value: { name: 'Dinner', on: { E15: {}, E7: { output: 40, cct: 2400 }, E8: {} } } },
    ]);
    // A document that has scenes: the next ID, no declaration; a retry skips one further.
    expect(saveNewScene(model, 'Dinner', lighting, lights).batch).toHaveLength(1);
    expect(nextSceneId(model)).toBe('LS2');
    expect(nextSceneId(model, 1)).toBe('LS3');
  });

  it('overwrites, renames and deletes a document’s scene with Ops on $document', () => {
    const lights = houseLights(model);
    expect(overwriteScene('LS1', sceneNamed(model.view, 'Evening')!.lighting, lights)).toEqual([{ op: 'setProperty', id: '$document', path: '/extensions/FS_lighting/scenes/LS1/on', value: { E15: {}, E7: { output: 40, cct: 2400 } } }]);
    expect(renameScene('LS1', 'Supper')).toEqual([{ op: 'setProperty', id: '$document', path: '/extensions/FS_lighting/scenes/LS1/name', value: 'Supper' }]);
    expect(deleteScene('LS1')).toEqual([{ op: 'unsetProperty', id: '$document', path: '/extensions/FS_lighting/scenes/LS1' }]);
  });

  it('refuses a name another scene, or a built-in, has', () => {
    expect(nameProblem(model, '  ')).toBe('Give the scene a name.');
    expect(nameProblem(model, 'evening')).toContain('already a scene');
    expect(nameProblem(model, 'Off')).toContain('already a scene');
    expect(nameProblem(model, 'Evening', 'LS1')).toBeNull();
    expect(nameProblem(model, 'Night light')).toBeNull();
    expect(cannotSave(model)).toBeNull();
  });

  it('keeps an explicit lighting’s settings when a switch flips others', () => {
    const three = new ThreeStore();
    const ids = houseLights(model).map((l) => l.id);
    three.chooseScene(panelScenes(model)[1]!);
    three.flipSwitch(['E8', 'E9'], ids);
    expect(settingOf(three.get().lighting, 'E7')).toEqual({ output: 40, cct: 2400 });
    expect(settingOf(three.get().lighting, 'E8')).toEqual({ output: 100 });
    expect(unchanged(three.get().lighting, panelScenes(model)[1], houseLights(model))).toBe(false);
  });
});
