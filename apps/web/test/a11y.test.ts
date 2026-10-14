/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { COMMANDS, codeOf, commandFor, commandForCode, keyOf } from '../src/editor/commands';
import { CONTEXT_KEYS, ariaKeys, keyHint, sheetGroups, spokenKeys, withKeys } from '../src/editor/shortcuts';
import { planElements, pickableIds } from '../src/editor/elements';
import { readModel } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import type { Layers } from '../src/editor/store';
import type { DeviceView } from '../src/editor/systems/view';
import { boxOf, IN, keyResize, keyRotate, resizeBatch, ruleFor, sizeOf, turnBatch } from '../src/furniture/resize';

/**
 * FLR-T-18.16, the keyboard and accessibility pass, below the browser: every command's keys are
 * written once, in the registry, in one notation, and the shortcut sheet is drawn from it; the
 * element list mirrors what the plan draws; a focused handle resizes and turns an item by its step.
 */

const HOUSE = readFileSync(new URL('../../../packages/assistants/staging/test/fixtures/courtyard.floorspec.json', import.meta.url), 'utf8');

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ev = (key: string, more: Partial<KeyboardEvent> = {}) => ({ key, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...more });

describe('shortcuts shown everywhere, from one registry', () => {
  it('gives every command a key reaches a hint, and every hint is in one notation', () => {
    const missing = COMMANDS.filter((c) => (c.keys !== undefined || c.codes !== undefined) && c.hint === undefined).map((c) => c.id);
    expect(missing).toEqual([]);
    // Mac glyphs, not words: "⇧F", never "Shift+F" (FLR-T-18.16 found arc.flip's).
    const wordy = COMMANDS.filter((c) => c.hint !== undefined && /(Shift|Mod|Alt|Ctrl|Cmd|Option)\+/.test(c.hint)).map((c) => `${c.id}: ${c.hint ?? ''}`);
    expect(wordy).toEqual([]);
  });

  it('binds no key or place twice', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const c of COMMANDS)
      for (const k of [...(c.keys ?? []).map((k) => `key:${k}`), ...(c.codes ?? []).map((k) => `code:${k}`)]) {
        const other = seen.get(k);
        if (other !== undefined) clash.push(`${k}: ${other} and ${c.id}`);
        seen.set(k, c.id);
      }
    expect(clash).toEqual([]);
  });

  it('opens the shortcut sheet with ?, the element list with ⌥L and the snap menu with ⇧S', () => {
    expect(commandFor(keyOf(ev('?', { shiftKey: true }), true))?.id).toBe('help.shortcuts');
    expect(commandFor(keyOf(ev('?'), false))?.id).toBe('help.shortcuts');
    // / is still quick add: ? is ⇧/ on a US keyboard, but its key is the character.
    expect(commandFor(keyOf(ev('/'), true))?.id).toBe('library.quickAdd');
    expect(commandForCode(codeOf({ ...ev('¬', { altKey: true }), code: 'KeyL' }, true))?.id).toBe('view.elements');
    expect(commandForCode(codeOf({ ...ev('S', { shiftKey: true }), code: 'KeyS' }, true))?.id).toBe('snap.menu');
    expect(keyHint('help.shortcuts')).toBe('?');
    expect(withKeys('History', 'history.toggle')).toBe('History (⌥H)');
    expect(withKeys('Nothing', 'no.such')).toBe('Nothing');
  });

  it('draws the sheet from the registry, by group, then the keys in context', () => {
    const groups = sheetGroups();
    const listed = groups.flatMap((g) => g.rows.map((r) => r.id));
    for (const c of COMMANDS.filter((x) => x.hint !== undefined)) expect(listed, c.id).toContain(c.id);
    expect(groups.map((g) => g.label)).toEqual(['Tools', 'Editing', 'View and navigation', 'History', ...CONTEXT_KEYS.map((g) => g.label)]);
    const undo = groups.flatMap((g) => g.rows).find((r) => r.id === 'edit.undo');
    expect(undo).toMatchObject({ label: 'Undo', keys: '⌘Z' });
  });

  it('searches the sheet by words, keys and keywords', () => {
    expect(sheetGroups('undo').flatMap((g) => g.rows.map((r) => r.id))).toEqual(expect.arrayContaining(['edit.undo']));
    expect(sheetGroups('⌥H').flatMap((g) => g.rows.map((r) => r.id))).toContain('history.toggle');
    expect(sheetGroups('electrical mode').flatMap((g) => g.rows.map((r) => r.id))).toEqual(['mode.electrical']);
    expect(sheetGroups('handle').map((g) => g.id)).toEqual(expect.arrayContaining(['plan', 'handles']));
    expect(sheetGroups('zzzz')).toEqual([]);
  });

  it('says keys in words for a screen reader, for the platform', () => {
    expect(spokenKeys('⌥H', true)).toBe('Option H');
    expect(spokenKeys('⇧⌘Z', true)).toBe('Shift Command Z');
    expect(spokenKeys('⇧⌘Z', false)).toBe('Shift Control Z');
    expect(spokenKeys('⌘\\', true)).toBe('Command Backslash');
    expect(spokenKeys('?', true)).toBe('Question mark');
    expect(spokenKeys('⇧ ← ↑ → ↓', true)).toBe('Shift Left arrow Up arrow Right arrow Down arrow');
  });

  it('writes aria-keyshortcuts for one chord, and nothing for a set of keys', () => {
    expect(ariaKeys('⌘K', true)).toBe('Meta+K');
    expect(ariaKeys('⌘K', false)).toBe('Control+K');
    expect(ariaKeys('⇧⌘Z', true)).toBe('Meta+Shift+Z');
    expect(ariaKeys('⌥1', true)).toBe('Alt+1');
    expect(ariaKeys('⌫', true)).toBe('Backspace');
    expect(ariaKeys('← ↑', true)).toBeUndefined();
    expect(ariaKeys(undefined, true)).toBeUndefined();
  });
});

describe('the element list mirrors the plan', () => {
  const model = readModel('h', HOUSE);
  const level = model.levels.find((l) => l.devices.some((d) => d.id === 'KIT-ISLAND'))!;
  const layers: Layers = { walls: true, openings: true, rooms: true, dimensions: true, findings: true, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false, roof: false };

  it('lists what the plan draws on the level, by kind, each with a name that says what it is and how big', () => {
    const groups = planElements({ model, level, layers, ghost: [], units: 'imperial' });
    const ids = groups.map((g) => g.id);
    expect(ids.slice(0, 3)).toEqual(['rooms', 'walls', 'openings']);
    expect(ids).toEqual(expect.arrayContaining(['casework', 'electrical']));
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    const devices = level.devices.length;
    expect(count).toBe(level.rooms.length + level.walls.length + level.openings.length + level.separators.length + level.slabs.length + level.stairs.length + devices);
    const kitchen = groups.find((g) => g.id === 'rooms')!.items.find((i) => i.label === 'Kitchen')!;
    expect(kitchen.meta).toMatch(/^room · [\d,.]+ ft²$/);
    const wall = groups.find((g) => g.id === 'walls')!.items[0]!;
    expect(wall.meta).toMatch(/long · .+ thick$/);
    const door = groups.find((g) => g.id === 'openings')!.items[0]!;
    expect(door.meta).toMatch(/^(door|window|opening) · .+ wide · in Wall /);
    const island = groups.flatMap((g) => g.items).find((i) => i.id === 'KIT-ISLAND')!;
    expect(island.meta).toContain('×');
    expect(pickableIds(groups)).toHaveLength(count);
  });

  it('leaves out a layer turned Off, and lists a ghosted one as not pickable', () => {
    const off = planElements({ model, level, layers: { ...layers, electrical: false, walls: false }, ghost: [], units: 'imperial' });
    expect(off.map((g) => g.id)).not.toContain('electrical');
    expect(off.map((g) => g.id)).not.toContain('walls');
    const ghosted = planElements({ model, level, layers, ghost: ['walls', 'openings'], units: 'imperial' });
    const walls = ghosted.find((g) => g.id === 'walls')!;
    expect(walls.items.every((i) => i.ghost)).toBe(true);
    expect(pickableIds(ghosted)).not.toContain(walls.items[0]!.id);
    expect(ghosted.find((g) => g.id === 'rooms')!.items.every((i) => !i.ghost)).toBe(true);
  });

  it('lists the person’s own dimensions and notes with the dimensions layer, picked one at a time', () => {
    const annotations = { dimensions: [{ id: 'DIM1', lengths: [12 * 12 * IN, 6 * 12 * IN] }], notes: [{ id: 'NOTE1', text: 'Check the header height over the pantry door before ordering' }] };
    const groups = planElements({ model, level, layers, ghost: [], units: 'imperial', annotations });
    const anno = groups.find((g) => g.id === 'annotations')!;
    expect(anno.label).toBe('Dimensions and notes');
    expect(anno.items.map((i) => [i.label, i.annotation])).toEqual([['Dimension DIM1', true], ['Note NOTE1', true]]);
    expect(anno.items[0]!.meta).toMatch(/^dimension · 12.+ \+ 6/);
    expect(anno.items[1]!.meta).toMatch(/^note · “Check the header.+…”$/);
    expect(pickableIds(groups)).not.toContain('DIM1');
    expect(planElements({ model, level, layers: { ...layers, dimensions: false }, ghost: [], units: 'imperial', annotations }).some((g) => g.id === 'annotations')).toBe(false);
  });

  it('shows the roofs only with the roof layer, as the plan does', () => {
    const withRoof = planElements({ model, level, layers: { ...layers, roof: true }, ghost: [], units: 'imperial' });
    expect(withRoof.some((g) => g.id === 'roofs')).toBe(level.roofs.length > 0);
    expect(planElements({ model, level, layers, ghost: [], units: 'imperial' }).some((g) => g.id === 'roofs')).toBe(false);
  });
});

describe('handles from the keyboard', () => {
  const commit = (doc: string, batch: Batch): string => {
    const r = apply(doc, { batch }, OFFICIAL_READER);
    if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    return r.document;
  };
  const deviceIn = (doc: string, id: string): DeviceView => readModel('h', doc).levels.flatMap((l) => l.devices).find((d) => d.id === id)!;
  const island = deviceIn(HOUSE, 'KIT-ISLAND');

  it('moves an edge out by the item’s step onto its grid, held at the other side; ⇧ moves four steps', () => {
    const was = sizeOf(boxOf(island.element)!);
    const out = keyResize(island, 'left', 1, false)!;
    // 70⅞″ → 72″: the island's 3″ module.
    expect(out).toEqual({ anchor: 'right', size: { width: 72 * IN } });
    expect(keyResize(island, 'left', 1, true)!.size.width).toBe(81 * IN);
    expect(keyResize(island, 'front', -1, false)).toEqual({ anchor: 'back', size: { depth: Math.ceil(was.depth / (3 * IN)) * 3 * IN - 3 * IN } });
    const after = commit(HOUSE, resizeBatch('KIT-ISLAND', out.anchor, out.size, ruleFor(island)));
    expect(sizeOf(boxOf(deviceIn(after, 'KIT-ISLAND').element)!).width).toBe(72 * IN);
  });

  it('moves a corner both ways, and stops at the item’s limits', () => {
    const corner = keyResize(island, 'front-left', 1, false)!;
    expect(Object.keys(corner.size).sort()).toEqual(['depth', 'width']);
    let d = island;
    let doc = HOUSE;
    // Down to the island's smallest width (36″), then no further.
    for (let i = 0; i < 20; i++) {
      const next = keyResize(d, 'left', -1, true);
      if (next === null) break;
      doc = commit(doc, resizeBatch('KIT-ISLAND', next.anchor, next.size, ruleFor(d)));
      d = deviceIn(doc, 'KIT-ISLAND');
    }
    expect(sizeOf(boxOf(d.element)!).width).toBe(36 * IN);
    expect(keyResize(d, 'left', -1, false)).toBeNull();
  });

  it('turns a freely standing item 15° a press, 1° with ⇧, clockwise for →', () => {
    const free = readModel('h', HOUSE).levels.flatMap((l) => l.devices).find((x) => x.extension === 'FS_furniture' && (x.host?.['mode'] === 'surface' || x.host?.['mode'] === 'free') && boxOf(x.element) !== null)!;
    const now = typeof free.host?.['rotation'] === 'number' ? free.host['rotation'] : 0;
    const cw = keyRotate(free, 1, false)!;
    expect(Math.abs(cw - now)).toBeLessThanOrEqual(15_000_000);
    expect(Math.abs(cw % 15_000_000)).toBe(0);
    expect(Math.abs(keyRotate(free, -1, true)! % 1_000_000)).toBe(0);
    const turned = deviceIn(commit(HOUSE, turnBatch(free, cw)), free.id);
    expect(turned.host?.['rotation'] ?? 0).toBe(cw);
    expect(keyRotate(island, 1, false) === null || island.host?.['mode'] !== 'wallFace').toBe(true);
  });
});
