/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { exteriorOutline, type FloorspecDocument } from '@floorspec/engine';
import { readModel } from '../src/editor/model';
import { addLevel, addRoof, addStair, levelAbove } from '../src/editor/ops';
import { stairsSchedule } from '../src/schedules/derive';

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
});
