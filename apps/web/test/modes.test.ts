/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/editor/store';
import { readModel } from '../src/editor/model';
import { MODE_COMMANDS, MODES, ModesStore, modeKey, pickable } from '../src/editor/modes';
import { COMMANDS, codeOf, commandForCode } from '../src/editor/commands';
import { visible } from '../src/editor/systems/hit';
import { openView, saveView } from '../src/editor/panzoom';
import { fit } from '../src/editor/viewport';
import { modesOf } from '../src/editor/modes';

/**
 * FLR-T-18.3: the editor's trade modes. A mode sets the layers and the ghosts in one step; a layer
 * set otherwise is marked and Reset puts it back; a person's own mode is saved and comes back; the
 * mode is remembered per project; ghosts are not picked; ⌥1–⌥7 and the palette reach every mode.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');

let kept: Map<string, string>;
beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function editor(project = 'p1'): EditorStore {
  const store = new EditorStore(project);
  const model = readModel('h', HOUSE);
  store.set({ model, level: model.levels[0]?.id ?? null, status: 'ready' });
  return store;
}

describe('trade modes (FLR-T-18.3)', () => {
  it('starts with every layer, as before modes', () => {
    const modes = new ModesStore(editor());
    expect(modes.get().mode).toBeNull();
    expect(Object.entries(modes.states()).filter(([, s]) => s !== 'on')).toEqual([['roof', 'off']]);
    expect(modes.changed().size).toBe(0);
    expect(modes.rail()).toBeNull();
  });

  it('a mode sets the layers, the ghosts and the rail in one step', () => {
    const store = editor();
    const modes = new ModesStore(store);
    modes.setMode('electrical');
    expect(modes.states()).toEqual(MODES.electrical.layers);
    expect(store.get().layers.walls).toBe(true); // drawn, as a ghost
    expect(store.get().layers.plumbing).toBe(false);
    expect(modes.get().ghost).toContain('walls');
    expect(modes.rail()?.some((r) => 'device' in r && r.device === 'receptacle')).toBe(true);
    expect(modes.rail()?.some((r) => 'tool' in r && r.tool === 'wall')).toBe(false);
  });

  it('puts down a tool the new rail does not offer', () => {
    const store = editor();
    const modes = new ModesStore(store);
    store.setTool('wall');
    modes.setMode('construction');
    expect(store.get().tool).toBe('wall');
    modes.setMode('electrical');
    expect(store.get().tool).toBe('select');
  });

  it('a layer set otherwise is marked; Reset puts the preset back', () => {
    const modes = new ModesStore(editor());
    modes.setMode('electrical');
    modes.setLayer('walls', 'on');
    modes.setLayer('plumbing', 'ghost');
    expect([...modes.changed()].sort()).toEqual(['plumbing', 'walls']);
    modes.reset();
    expect(modes.changed().size).toBe(0);
    expect(modes.states()).toEqual(MODES.electrical.layers);
  });

  it('is remembered per project, with the layers as they were left', () => {
    const first = new ModesStore(editor('p1'));
    first.setMode('decorator');
    first.setLayer('dimensions', 'ghost');
    expect(JSON.parse(kept.get(modeKey('p1'))!)).toMatchObject({ mode: 'decorator', states: { dimensions: 'ghost' } });
    const again = new ModesStore(editor('p1'));
    expect(again.get().mode).toBe('decorator');
    expect(again.states().dimensions).toBe('ghost');
    expect(new ModesStore(editor('p2')).get().mode).toBeNull();
  });

  it('a person’s own mode: the current layers, named, switched to and kept; a preset of their own', () => {
    const modes = new ModesStore(editor());
    modes.setMode('plumbing');
    modes.setLayer('casework', 'on');
    const id = modes.saveAsMode('Kitchen remodel')!;
    expect(id).toBe('custom:kitchen-remodel');
    expect(modes.get().mode).toBe(id);
    expect(modes.nameOf()).toBe('Kitchen remodel');
    expect(modes.tradeOf()).toBe('plumbing');
    expect(modes.presetOf(id).casework).toBe('on');
    expect(modes.saveAsMode('Kitchen remodel')).toBe('custom:kitchen-remodel-2');
    // The trade's own preset made a person's own; Reset returns to it; restored as it ships.
    modes.setMode('electrical');
    modes.setLayer('walls', 'on');
    modes.savePreset();
    expect(modes.changed().size).toBe(0);
    modes.setMode('construction');
    modes.setMode('electrical');
    expect(modes.states().walls).toBe('on');
    modes.restorePreset('electrical');
    expect(modes.states()).toEqual(MODES.electrical.layers);
    const back = new ModesStore(editor());
    expect(back.get().custom.map((c) => c.name)).toEqual(['Kitchen remodel', 'Kitchen remodel']);
    back.deleteCustom('custom:kitchen-remodel-2');
    expect(back.get().custom).toHaveLength(1);
  });

  it('ghosts are not picked: the level a click picks from leaves them out', () => {
    const store = editor();
    const level = store.levelView!;
    const view = pickable(level, ['walls', 'openings', 'furniture']);
    expect(view.walls).toHaveLength(0);
    expect(view.openings).toHaveLength(0);
    expect(view.junctions).toHaveLength(0);
    expect(view.devices.some((d) => d.extension === 'FS_furniture' && d.collection === 'pieces')).toBe(false);
    expect(view.devices.some((d) => d.extension === 'FS_electrical')).toBe(true);
    expect(pickable(level, ['walls', 'openings', 'furniture'])).toBe(view);
    expect(pickable(level, [])).toBe(level);
  });

  it('the casework and the garden are layers of their own', () => {
    const level = editor().levelView!;
    const cabinet = level.devices.find((d) => d.collection === 'casework')!;
    const plant = level.devices.find((d) => d.extension === 'FS_landscape');
    const all = editor().get().layers;
    expect(visible(cabinet, all)).toBe(true);
    expect(visible(cabinet, { ...all, casework: false })).toBe(false);
    if (plant !== undefined) expect(visible(plant, { ...all, landscape: false })).toBe(false);
  });

  it('a saved view keeps its mode and brings it back (FLR-T-18.6)', () => {
    const store = editor('views');
    store.set({ view: fit(store.levelView?.bounds ?? null, 800, 600) });
    const modes = modesOf(store);
    modes.setMode('electrical');
    const saved = saveView(store, 'Wiring', modes.get().mode)!;
    expect(saved.mode).toBe('electrical');
    modes.setMode('decorator');
    expect(openView(store, saved)).toBe(true);
    expect(modes.get().mode).toBe('electrical');
    // A mode no longer there leaves the mode as it is.
    modes.setMode('decorator');
    openView(store, { ...saved, mode: 'custom:gone' });
    expect(modes.get().mode).toBe('decorator');
  });

  it('⌥1–⌥7 by the key’s place, and every mode in the palette', () => {
    const key = (code: string, mods: Partial<Record<'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => commandForCode(codeOf({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, code, ...mods }, true))?.id;
    expect(key('Digit3', { altKey: true })).toBe('mode.electrical');
    expect(key('Digit7', { altKey: true })).toBe('mode.landscape');
    expect(key('Digit8', { altKey: true })).toBeUndefined();
    expect(key('Digit1', { altKey: true, metaKey: true })).toBeUndefined();
    expect(key('Digit1', { altKey: true, shiftKey: true })).toBeUndefined();
    for (const c of MODE_COMMANDS) expect(COMMANDS).toContain(c);
    expect(COMMANDS.find((c) => c.id === 'mode.landscape')?.hint).toBe('⌥7');
  });
});
