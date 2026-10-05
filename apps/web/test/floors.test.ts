import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import type { FloorspecDocument } from '@floorspec/engine';
import { readModel } from '../src/editor/model';
import { addSlab } from '../src/editor/ops';
import { startingCeiling } from '../src/editor/floors';

/** Floors, ceilings and slabs as the editor writes them (Core 0.3, chapter 15) — each batch through the real applier. */

const IN = 32_512;
const FT = 12 * IN;
const TEMPLATE = readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8');

function commit(doc: string, batch: Parameters<typeof apply>[1]): string {
  const r = apply(doc, batch);
  if (r.status !== 'committed') throw new Error(r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
  return r.document;
}

describe('floors, ceilings and slabs in the editor', () => {
  const house = readModel('h', TEMPLATE);
  const liv = house.levels[0]?.rooms.find((r) => r.id === 'LIV');

  it('derives every room a floor and a flat ceiling by default, and the model carries them', () => {
    expect(liv?.ceiling).toMatchObject({ kind: 'flat' });
    expect(liv?.floorTop).toBe(0);
  });

  it('starts a vault along the room, its ridge high enough to meet the walls at the old height', () => {
    const vault = startingCeiling('vaulted', undefined, liv, 3_200_000);
    const doc = commit(TEMPLATE, { batch: [{ op: 'setProperty', id: 'LIV', path: '/ceiling', value: vault }] });
    const room = readModel('v', doc).levels[0]?.rooms.find((r) => r.id === 'LIV');
    expect(room?.ceiling?.kind).toBe('vaulted');
    expect(room?.ceiling?.ridge).toEqual(vault['ridge']);
    expect(room?.ceiling?.high).toBe(vault['height']);
    expect(room?.ceiling?.low).toBeGreaterThanOrEqual(3_200_000 - 1);
  });

  it('starts a tray a foot in from the walls, six inches deep', () => {
    const tray = startingCeiling('tray', { kind: 'flat', height: 9 * FT }, liv, 3_200_000);
    expect(tray).toEqual({ kind: 'tray', height: 9 * FT, border: FT, depth: 6 * IN });
    const room = readModel('t', commit(TEMPLATE, { batch: [{ op: 'setProperty', id: 'LIV', path: '/ceiling', value: tray }] })).levels[0]?.rooms.find((r) => r.id === 'LIV');
    expect(room?.ceiling?.tray?.[0]?.length).toBeGreaterThanOrEqual(4);
  });

  it('draws a slab with its purpose in a 0.3 plan, and without one in a 0.2 plan', () => {
    const outline: [number, number][] = [[0, -10 * FT], [12 * FT, -10 * FT], [12 * FT, -FT], [0, -FT]];
    const opts = { thickness: 4 * IN, offset: -2 * IN, purpose: 'patio' };
    const doc = commit(TEMPLATE, { batch: addSlab(JSON.parse(TEMPLATE) as FloorspecDocument, 'MAIN', outline, opts) });
    const m = readModel('s', doc);
    expect(m.levels[0]?.slabs).toEqual([{ id: 'SL1', outline, purpose: 'patio', top: -2 * IN, bottom: -6 * IN }]);
    const as02 = { ...(JSON.parse(TEMPLATE) as FloorspecDocument), floorspec: '0.2' } as FloorspecDocument;
    const batch = addSlab(as02, 'MAIN', outline, opts);
    expect(JSON.stringify(batch)).not.toContain('purpose');
    commit(JSON.stringify(as02), { batch });
  });
});
