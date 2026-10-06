/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { exteriorOutline, type FloorspecDocument } from '@floorspec/engine';
import { readModel } from '../src/editor/model';
import { addLevel, addRoof, addStair, levelAbove, stairForm } from '../src/editor/ops';
import { upgradeToCurrent } from '../src/editor/openings';
import { stairsSchedule } from '../src/schedules/derive';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FORMS, linesText, RoofBody, StairBody } from '../src/editor/RoofStairFields';
import { RoofEdgeTags, roofStairOutline, StairsLayer } from '../src/editor/RoofStairLayer';
import { EditorStore, type Viewport } from '../src/editor/store';
import { toScreen } from '../src/editor/viewport';
import { idShown } from '../src/editor/Tree';
import type { EditorModel } from '../src/editor/model';
import type { FloorCtx } from '../src/editor/FloorFields';

/** Roofs and stairs as the editor writes them (Core 0.3, chapters 16 and 17) — each batch through the real applier. */

const IN = 32_512;
const FT = 12 * IN;
const TEMPLATE = readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8');
const doc = (text: string): FloorspecDocument => JSON.parse(text) as FloorspecDocument;

function commit(text: string, batch: object[]): string {
  const r = apply(text, { batch });
  if (r.status !== 'committed') throw new Error(r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
  return r.document;
}

const ROOF = { rise: 6, run: 12, overhang: FT, gables: false };
const STAIR = { form: 'straight' as const, turn: 'left' as const, width: 36 * IN, tread: 10 * IN, maxRiser: 7.75 * IN };

describe('roofs in the editor', () => {
  it('roofs the template over its walls: a 6:12 hip with a foot of overhang, drawn on the roof layer', () => {
    const [ring] = exteriorOutline(TEMPLATE, 'MAIN');
    const text = commit(TEMPLATE, addRoof(doc(TEMPLATE), 'MAIN', ring!, ROOF));
    const roof = readModel('r', text).levels[0]?.roofs[0];
    expect(roof?.id).toBe('RF1');
    expect(roof?.derived.kind).toBe('hip');
    expect(roof?.derived.surface?.faces).toHaveLength(4);
    expect(roof?.derived.surface?.lines.map((l) => l.kind).sort()).toEqual(['hip', 'hip', 'hip', 'hip', 'ridge']);
    expect(roof?.derived.outline[0]).toEqual([-38_608 - FT, -38_608 - FT]);
  });

  it('makes the two short ends gables when asked, on a four-sided footprint', () => {
    const fp: [number, number][] = [[0, 0], [36 * FT, 0], [36 * FT, 24 * FT], [0, 24 * FT]];
    const batch = addRoof(doc(TEMPLATE), 'MAIN', fp, { ...ROOF, gables: true });
    expect((batch[0] as unknown as { element: { edges: unknown } }).element.edges).toEqual({ '1': { gable: true }, '3': { gable: true } });
    expect(readModel('g', commit(TEMPLATE, batch)).levels[0]?.roofs[0]?.derived.kind).toBe('gable');
  });

  it('upgrades a 0.2 plan to 0.3 in the same batch, since roofs are Core 0.3', () => {
    const as02 = JSON.stringify({ ...doc(TEMPLATE), floorspec: '0.2' });
    const batch = addRoof(doc(as02), 'MAIN', [[0, 0], [FT, 0], [FT, FT]], ROOF);
    expect(batch[0]).toEqual({ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' });
    expect(doc(commit(as02, batch)).floorspec).toBe('0.3');
  });
});

describe('stairs in the editor', () => {
  // A second level above the template's, with walls of its own: the stair rises into it.
  const twoLevels = commit(TEMPLATE, addLevel(doc(TEMPLATE), { name: 'Upper', elevation: 3_511_296, height: 3_200_000 })(0));
  const upper = levelAbove(doc(twoLevels), 'MAIN');

  it('rises to the next level up in the building, and from the top level to none', () => {
    expect(upper).toBeDefined();
    expect(levelAbove(doc(twoLevels), upper!)).toBeUndefined();
  });

  it('places a straight stair whose riser count follows the rise, scheduled with its derived values', () => {
    const text = commit(twoLevels, addStair(doc(twoLevels), 'MAIN', upper!, [2 * FT, 4 * FT], 0, STAIR));
    const model = readModel('s', text);
    const st = model.levels.find((l) => l.id === 'MAIN')?.stairs[0];
    expect(st?.id).toBe('ST1');
    // 3,511,296 / 251,968 = 13.9…: 14 risers of 250,807 (rounded once).
    expect(st?.derived.risers).toBe(14);
    expect(st?.derived.riserHeight).toBe(250_807);
    expect(st?.derived.steps).toHaveLength(13);
    expect(st?.derived.footRoom).toBe('LIV');
    const schedule = stairsSchedule(model, 'imperial');
    expect(schedule.rows.map((r) => [r.cells['mark']?.text, r.cells['risers']?.text])).toEqual([['ST1', '14']]);
  });

  it('turns an L stair halfway, rising north', () => {
    const batch = addStair(doc(twoLevels), 'MAIN', upper!, [2 * FT, 2 * FT], 90_000_000, { ...STAIR, form: 'lShaped' });
    expect((batch[0] as unknown as { element: Record<string, unknown> }).element).toMatchObject({ rotation: 90_000_000, form: { kind: 'lShaped', turn: 'left', risersBeforeTurn: 7 } });
    const st = readModel('l', commit(twoLevels, batch)).levels.find((l) => l.id === 'MAIN')?.stairs[0];
    expect(st?.form).toBe('lShaped');
    expect(st?.derived.steps?.filter((s) => s.landing)).toHaveLength(1);
    expect(st?.derived.walkline?.points).toHaveLength(3);
  });

  it('draws a quarter-turn winder: three winders between its flights, tapered on rays from the turn (Core 0.4, 17.7)', () => {
    const batch = addStair(doc(twoLevels), 'MAIN', upper!, [2 * FT, 2 * FT], 90_000_000, { ...STAIR, form: 'winder' });
    expect((batch[0] as unknown as { element: Record<string, unknown> }).element).toMatchObject({ form: { kind: 'winder', turn: 'left', angle: 'quarter', risersBeforeTurn: 6, winders: 3 } });
    const st = readModel('w', commit(twoLevels, batch)).levels.find((l) => l.id === 'MAIN')?.stairs[0];
    expect(st?.form).toBe('winder');
    expect(st?.derived.steps?.filter((s) => s.winder)).toHaveLength(3);
    expect(st?.derived.steps?.some((s) => s.landing)).toBe(false);
    // Without a newel the winders meet at the pivot: their narrow ends have no going.
    expect(st?.derived.narrowGoing).toBe(0);
    expect(st?.derived.walklineGoing).toBeGreaterThan(0);
    expect(Number.isInteger(st?.derived.walkline?.length)).toBe(true);
  });

  it('draws a spiral sweeping 270° about a 3" column, its centre derived', () => {
    expect(stairForm('spiral', 'right', 14, 26 * IN)).toEqual({ kind: 'spiral', turn: 'right', diameter: 58 * IN, sweep: 270_000_000 });
    const batch = addStair(doc(twoLevels), 'MAIN', upper!, [10 * FT, 10 * FT], 0, { ...STAIR, form: 'spiral', width: 26 * IN });
    const st = readModel('p', commit(twoLevels, batch)).levels.find((l) => l.id === 'MAIN')?.stairs[0];
    expect(st?.form).toBe('spiral');
    expect(st?.column).toBe(3 * IN);
    expect(st?.derived.centre).toBeDefined();
    // 14 risers: 13 treads, the last riser reaching the floor above.
    expect(st?.derived.risers).toBe(14);
    expect(st?.derived.steps).toHaveLength(13);
    expect(st?.derived.steps?.every((s) => s.outline.length === 4)).toBe(true);
  });

  it('gives a winder a newel and a stair its design headroom only in a Core 0.4 plan: upgraded in the same batch', () => {
    const text = commit(twoLevels, addStair(doc(twoLevels), 'MAIN', upper!, [2 * FT, 2 * FT], 90_000_000, { ...STAIR, form: 'winder' }));
    const form = (doc(text).stairs?.['ST1'] as unknown as { form: Record<string, unknown> }).form;
    const edits = [
      { op: 'setProperty', id: 'ST1', path: '/form', value: { ...form, newel: 4 * IN } },
      { op: 'setProperty', id: 'ST1', path: '/minHeadroom', value: 80 * IN },
    ];
    const as03 = JSON.stringify({ ...doc(text), floorspec: '0.3' });
    expect(apply(as03, { batch: edits }).status).toBe('rejected');
    const up = commit(as03, [...upgradeToCurrent(doc(as03)), ...edits]);
    expect(doc(up).floorspec).toBe('0.4');
    const st = readModel('n', up).levels.find((l) => l.id === 'MAIN')?.stairs[0];
    expect(st?.derived.narrowGoing).toBeGreaterThan(0);
    expect(st?.derived.opening?.first).toBeGreaterThanOrEqual(0);
  });
});

// ─── FLR-T-12.9: the roof and stair UI, as the board's P7 · Roofs & stairs frames draw it ─────────

describe('roof and stair polish (FLR-T-12.9)', () => {
  const twoLevels = commit(TEMPLATE, addLevel(doc(TEMPLATE), { name: 'Upper', elevation: 3_511_296, height: 3_200_000 })(0));
  const upper = levelAbove(doc(twoLevels), 'MAIN')!;
  const view: Viewport = { cx: 5 * FT, cy: 5 * FT, s: 0.0001, w: 1200, h: 900 };
  const markup = (node: ReactElement): string => renderToStaticMarkup(node);
  const stairModel = (form: 'winder' | 'spiral' | 'lShaped', edits: object[] = [], as03 = false) => {
    let text = commit(twoLevels, addStair(doc(twoLevels), 'MAIN', upper, [2 * FT, 2 * FT], 90_000_000, { ...STAIR, form }));
    if (edits.length > 0) text = commit(text, [...upgradeToCurrent(doc(text)), ...edits]);
    if (as03) text = JSON.stringify({ ...doc(text), floorspec: '0.3' });
    return readModel('s', text);
  };
  const ctxOf = (model: EditorModel, id: string): FloorCtx => {
    const kind = model.document.stairs?.[id] !== undefined ? 'stairs' : 'roofs';
    return { store: new EditorStore('t'), model, id, element: (model.document[kind] as Record<string, Record<string, unknown>>)[id]!, units: 'imperial', readOnly: false, edit: () => undefined };
  };

  it('outlines a selected roof or stair without filling it, so its lines and treads stay visible', () => {
    const m = stairModel('winder');
    const level = m.levels.find((l) => l.id === 'MAIN')!;
    const html = markup(createElement('svg', null, roofStairOutline(view, level, 'ST1', 'fs-hl fs-hl--selected')));
    expect(html).toContain('class="fs-hl fs-hl--selected fs-hl--outline"');
    const css = readFileSync(new URL('../src/editor/editor.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.fs-hl\.fs-hl--outline \{\s*fill: none;/);
  });

  it('tints winders, draws the newel, marks where the floor above opens, and writes UP clear of the stair', () => {
    const plain = stairModel('winder');
    const form = (plain.document.stairs?.['ST1'] as unknown as { form: Record<string, unknown> }).form;
    const m = stairModel('winder', [
      { op: 'setProperty', id: 'ST1', path: '/form', value: { ...form, newel: 4 * IN } },
      { op: 'setProperty', id: 'ST1', path: '/minHeadroom', value: 80 * IN },
    ]);
    const level = m.levels.find((l) => l.id === 'MAIN')!;
    const st = level.stairs[0]!;
    expect(st.newel).toHaveLength(4);
    const html = markup(createElement('svg', null, createElement(StairsLayer, { view, level })));
    expect(html.match(/fs-stair__step--winder/g)).toHaveLength(3);
    expect(html).toContain('data-newel="ST1"');
    expect(html).toContain('data-opening="ST1"');
    expect(html).toContain('data-up="ST1"');
    // UP sits beyond the stair's box on screen, not on it.
    const x = Number(/data-up="ST1" x="([-\d.]+)"/.exec(html)![1]);
    const y = Number(/data-up="ST1" x="[-\d.]+" y="([-\d.]+)"/.exec(html)![1]);
    const { min, max } = st.derived.box;
    const [x0, y1] = toScreen(view, [min[0], min[1]]);
    const [x1, y0] = toScreen(view, [max[0], max[1]]);
    expect(x < x0 || x > x1 || y < y0 || y > y1).toBe(true);
    // A straight-flight stair has no tint and no newel.
    const l = stairModel('lShaped').levels.find((v) => v.id === 'MAIN')!;
    const lh = markup(createElement('svg', null, createElement(StairsLayer, { view, level: l })));
    expect(lh).not.toContain('fs-stair__step--winder');
    expect(lh).not.toContain('data-newel');
  });

  it('numbers a roof’s edges from 1 on the plan and in the inspector, one compact row an edge', () => {
    const fp: [number, number][] = [[0, 0], [30 * FT, 0], [30 * FT, 10 * FT], [20 * FT, 10 * FT], [20 * FT, 20 * FT], [10 * FT, 20 * FT], [10 * FT, 10 * FT], [0, 10 * FT]];
    const m = readModel('r', commit(TEMPLATE, addRoof(doc(TEMPLATE), 'MAIN', fp, ROOF)));
    const level = m.levels[0]!;
    const tags = markup(createElement('svg', null, createElement(RoofEdgeTags, { view, level, id: 'RF1' })));
    expect([...tags.matchAll(/data-edge="(\d+)"/g)].map((x) => x[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const html = markup(createElement(RoofBody, { ctx: ctxOf(m, 'RF1') }));
    expect(html.match(/class="fs-edges__row"/g)).toHaveLength(8);
    expect(html).toContain('aria-label="Edge 1 (30&#x27;-0&quot;) is a gable end"');
    expect(html).toContain('aria-label="Edge 8 pitch rise (in 12)"');
    expect(html).not.toMatch(/Edge 0\b/);
    // The derived summary is split, and wraps rather than being cut off.
    expect(html).toContain('>Faces<');
    expect(html).toContain('fs-readonly fs-readonly--wrap');
    expect(linesText([{ kind: 'ridge' }, { kind: 'hip' }, { kind: 'hip' }, { kind: 'valley' }, { kind: 'break' }])).toBe('1 ridge, 2 hips, 1 valley, 1 break');
    // No placeholder is a sentence the field cannot hold.
    expect(html).not.toContain('(the level&#x27;s height)');
  });

  it('on a pre-0.4 plan, says where the newel would be that it and the design headroom need 0.4', () => {
    const m = stairModel('winder', [], true);
    const html = markup(createElement(StairBody, { ctx: ctxOf(m, 'ST1') }));
    expect(html.match(/This plan is Floorspec 0.3/g)).toHaveLength(1);
    expect(html).toContain('newel and a stair’s design headroom'.replace('’', '&#x27;'));
    // Where the newel would be: after Winders, before Width — not after "Rises to".
    const notice = html.indexOf('This plan is Floorspec 0.3');
    expect(html.indexOf('>Winders<')).toBeLessThan(notice);
    expect(notice).toBeLessThan(html.indexOf('>Width<'));
    // An L stair says it where the design headroom would be.
    const lh = markup(createElement(StairBody, { ctx: ctxOf(stairModel('lShaped', [], true), 'ST1') }));
    expect(lh.indexOf('>Rises to<')).toBeLessThan(lh.indexOf('This plan is Floorspec 0.3'));
  });

  it('names forms alike in the tool and the inspector, and a spiral’s tread does not claim to set its going', () => {
    expect(FORMS.map(([, label]) => label)).toEqual(['Straight', 'L-shaped', 'U-shaped', 'Winder', 'Spiral']);
    const src = readFileSync(new URL('../src/editor/RoofStairFields.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/label: 'L' \}|label: 'U' \}/);
    const spiral = markup(createElement(StairBody, { ctx: ctxOf(stairModel('spiral'), 'ST1') }));
    expect(spiral).not.toContain('nosing to nosing');
    expect(spiral).toContain('diameter and sweep set it');
    expect(spiral).toContain('Least going, walkline');
  });

  it('does not repeat an unnamed element’s ID in the tree', () => {
    expect(idShown('Stair ST1', 'ST1')).toBe(true);
    expect(idShown('Main stair', 'ST1')).toBe(false);
    expect(idShown('Wall W10', 'W1')).toBe(false);
  });
});
