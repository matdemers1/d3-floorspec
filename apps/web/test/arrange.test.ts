/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type EditorModel, type LevelView } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { alignBatch, distributeBatch, middleOf, mirror, quarterTurn, transformBatch, translation } from '../src/editor/arrange/transform';
import { marqueeHits, rectOf, selectableShapes } from '../src/editor/arrange/shapes';

/**
 * FLR-T-18.8: arranging many elements of the Courtyard House at once, through the real applier as
 * the server applies it — every gesture one batch that commits.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const LAYERS = { walls: true, openings: true, rooms: true, dimensions: true, findings: true, electrical: true, plumbing: true, mechanical: true, lowvoltage: true, clearances: false, coreOnly: false, roof: false };

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}
const house = (): EditorModel => readModel('h', HOUSE);
const L1 = (m: EditorModel): LevelView => m.levels.find((l) => l.id === 'L1')!;
const host = (doc: string, id: string) => readModel('h', doc).levels.flatMap((l) => l.devices).find((d) => d.id === id)!.host!;

describe('moving many at once', () => {
  it('moves the three west dining chairs 1 ft east as one batch', () => {
    const m = house();
    const ids = ['GR-CW0', 'GR-CW1', 'GR-CW2'];
    const t = transformBatch(m, L1(m), ids, translation([390_144, 0]));
    expect(t.moved).toEqual(ids);
    const doc = commit(HOUSE, t.batch);
    expect(host(doc, 'GR-CW1')['position']).toEqual([16336192 + 390_144, 15800832]);
    expect(host(doc, 'GR-CW1')['room']).toBe('R7');
  });

  it('moves a room with its walls, its openings and devices following', () => {
    const m = house();
    const level = L1(m);
    const walls = level.walls.filter((w) => {
      const f = level.faces.find((x) => x.room === 'R4')!;
      return f.outer.some((p) => p[0] === w.a[0] && p[1] === w.a[1]) && f.outer.some((p) => p[0] === w.b[0] && p[1] === w.b[1]);
    });
    const t = transformBatch(m, level, ['R4', ...walls.map((w) => w.id)], translation([0, 32_512]));
    expect(t.skipped).toEqual([]);
    const doc = commit(HOUSE, t.batch);
    expect((JSON.parse(doc).rooms.R4 as { anchor: number[] }).anchor).toEqual([14435328, 1170432 + 32_512]);
  });

  it('turns and mirrors a group of furniture about its middle', () => {
    const m = house();
    const ids = ['GR-CW0', 'GR-CW1', 'GR-CW2', 'GR-TABLE', 'GR-CE0', 'GR-CE1', 'GR-CE2'];
    const c = middleOf(L1(m), ids)!;
    const turned = commit(HOUSE, transformBatch(m, L1(m), ids, quarterTurn(c, -1)).batch);
    expect(host(turned, 'GR-TABLE')['rotation']).toBe(-90_000_000);
    const flipped = commit(HOUSE, transformBatch(m, L1(m), ids, mirror(c, 'h')).batch);
    // The west chairs face east (0°); mirrored left ↔ right they face west.
    expect(host(flipped, 'GR-CW0')['rotation']).toBe(180_000_000);
  });

  it('mirrors walls without turning their exteriors inside', () => {
    const m = house();
    const level = L1(m);
    const f = level.faces.find((x) => x.room === 'R4')!;
    const walls = level.walls.filter((w) => f.outer.some((p) => p[0] === w.a[0] && p[1] === w.a[1]) && f.outer.some((p) => p[0] === w.b[0] && p[1] === w.b[1])).map((w) => w.id);
    const ids = ['R4', ...walls];
    const t = transformBatch(m, level, ids, mirror(middleOf(level, ids)!, 'v'));
    commit(HOUSE, t.batch);
  });

  it('aligns and distributes', () => {
    const m = house();
    const ids = ['GR-CW0', 'GR-CHAIR1', 'GR-CE0'];
    commit(HOUSE, alignBatch(m, L1(m), ids, 'top').batch);
    const d = distributeBatch(m, L1(m), ['GR-CW0', 'GR-CW1', 'GR-CW2', 'GR-CHAIR1'], 'y');
    commit(HOUSE, d.batch);
  });
});

describe('the marquee', () => {
  it('a window takes what is wholly inside; a crossing takes what it touches, but not the room', () => {
    const m = house();
    const shapes = selectableShapes(L1(m), LAYERS);
    // Around the west chairs, whose seats tuck under the table.
    const window = marqueeHits(shapes, rectOf([16_300_000, 14_850_000], [17_000_000, 16_750_000]), false);
    expect(window.filter((id) => id.startsWith('GR-'))).toEqual(['GR-CW0', 'GR-CW1', 'GR-CW2']);
    expect(window).not.toContain('R7');
    // A crossing over their backs catches the three west chairs and not the table (the board's frame).
    const crossing = marqueeHits(shapes, rectOf([16_500_000, 14_900_000], [16_300_000, 16_700_000]), true);
    expect(crossing.filter((id) => id.startsWith('GR-'))).toEqual(['GR-CW0', 'GR-CW1', 'GR-CW2']);
    expect(crossing).not.toContain('R7');
    // Wider, the crossing touches the table too.
    expect(marqueeHits(shapes, rectOf([16_300_000, 14_900_000], [16_900_000, 16_700_000]), true)).toContain('GR-TABLE');
  });
});
