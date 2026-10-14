/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/editor/store';
import { readModel } from '../src/editor/model';
import { modesOf } from '../src/editor/modes';
import { levelPaint, planLook, planStylesOf, styleFor, styleKey } from '../src/editor/planStyle';
import { ALL_DETAILS } from '@floorspec/render2d';
import { fit } from '../src/editor/viewport';

/**
 * FLR-T-18.5: the editor's plan styles. Colour by default and Technical in Construction mode, each
 * mode's choice its own; "PDF export only" leaves the canvas alone; remembered per project; and a
 * level's paint — floors in their finishes, walls by class and, in Construction, by type.
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

describe('plan styles in the editor (FLR-T-18.5)', () => {
  it('Colour by default, Technical in Construction; each keeps its own choice', () => {
    const store = editor();
    const styles = planStylesOf(store);
    expect(styles.current()).toBe('colour');
    modesOf(store).setMode('construction');
    expect(styles.current()).toBe('technical');
    styles.choose('blueprint');
    expect(styles.current()).toBe('blueprint');
    modesOf(store).setMode('decorator');
    expect(styles.current()).toBe('colour');
    styles.choose('presentation');
    modesOf(store).setMode('construction');
    expect(styles.current()).toBe('blueprint');
    expect(styleFor({ construction: null, other: null, details: ALL_DETAILS, exportStyle: null }, true)).toBe('technical');
  });

  it('a style for exports only leaves the canvas alone; the choice is remembered per project', () => {
    const store = editor();
    const styles = planStylesOf(store);
    styles.choose('technical', 'export');
    expect(styles.current()).toBe('colour');
    expect(styles.forExport()).toBe('technical');
    styles.setDetail('shadows', false);
    expect(JSON.parse(kept.get(styleKey('p1'))!)).toMatchObject({ exportStyle: 'technical', details: { shadows: false } });
    const again = planStylesOf(editor());
    expect(again.forExport()).toBe('technical');
    expect(again.get().details.shadows).toBe(false);
  });

  it('a level’s paint: floors in their finishes at true scale, walls by class, by type in Construction', () => {
    const store = editor();
    const { model, level } = store.get();
    const lv = model!.levels.find((l) => l.id === level)!;
    const view = fit(lv.bounds, 1200, 800);
    const colour = levelPaint(view, lv, model!, planLook('colour', 'light', ALL_DETAILS, false));
    expect(colour.floor('white-oak-floor')).toBe('url(#fsx-floor-white-oak-floor)');
    expect(colour.defs).toContain('<pattern id="fsx-floor-white-oak-floor"');
    expect(colour.wall('W1')).toMatchObject({ cls: 'exterior', hatch: false });
    const technical = levelPaint(view, lv, model!, planLook('technical', 'dark', ALL_DETAILS, false));
    expect(technical.wall('W1')).toMatchObject({ cls: 'exterior', hatch: true });
    expect(technical.defs).toContain('fsx-wall-hatch');
    const construction = levelPaint(view, lv, model!, planLook('technical', 'dark', ALL_DETAILS, true));
    expect(construction.wall('W1')).toMatchObject({ type: 'wall-2x6-exterior-brick-veneer' });
    expect(construction.legend.map((l) => l.id)).toContain('wall-2x4-interior');
    expect(planLook('colour', 'dark', ALL_DETAILS, true).vars['--fsx-door']).toBe('#f2b84b');
  });
});
