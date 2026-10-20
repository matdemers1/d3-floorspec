/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
/**
 * FLR-T-16.1: solar as the editor reads and writes it — the assistant's proposal for the Courtyard House on
 * its street, applied, is the fixture's first array; an array laid on a picked face joins the inverter; a
 * click picks an array or a face; and the Solar arrays schedule says each array's year as a range, beside
 * the other schedules, which solar leaves alone.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_READER } from '@floorspec/engine';
import { apply as applyLocally } from '@floorspec/ops';
import { readModel, type EditorModel } from '../src/editor/model';
import { proposalOf, solarDrawingOf, solarEstimateOf, optionsOf } from '../src/editor/solar/data';
import { schedules } from '../src/schedules/derive';

const STREET = readFileSync(new URL('../../worker/test/fixtures/courtyard-house-on-its-street.json', import.meta.url), 'utf8');
const SOLAR = readFileSync(new URL('../../worker/test/fixtures/courtyard-house-solar.json', import.meta.url), 'utf8');

function applied(model: EditorModel, batch: readonly unknown[]): EditorModel {
  const r = applyLocally(model.document, { batch: batch as never }, OFFICIAL_READER);
  expect(r.status, JSON.stringify(r.status === 'committed' ? [] : r.diagnostics)).toBe('committed');
  if (r.status !== 'committed') throw new Error('rejected');
  return readModel(r.hash, r.document);
}

describe('solar in the editor', () => {
  it('proposes, for the house on its street, what the fixture holds: the assistant’s array, then one on the guest wing', () => {
    let m = readModel('h', STREET);
    const p = proposalOf(m, optionsOf({ face: null, sizing: 'use', kwh: 12_000, cutoff: 0.75 }));
    if (typeof p === 'string') throw new Error(p);
    m = applied(m, p.batch);
    const one = proposalOf(m, { faces: ['RF2:2'] });
    if (typeof one === 'string') throw new Error(one);
    m = applied(m, one.batch);
    const want = (JSON.parse(SOLAR) as { extensions: { FS_energy: unknown } }).extensions.FS_energy;
    expect(m.document.extensions?.['FS_energy']).toEqual(want);
  });

  it('draws and estimates the fixture’s arrays, each a range', () => {
    const m = readModel('s', SOLAR);
    expect(solarDrawingOf(m).arrays.map((a) => [a.id, a.level, a.clear])).toEqual([
      ['PV1', 'L2', true],
      ['PV2', 'L1', true],
    ]);
    const e = solarEstimateOf(m);
    expect(e.arrays.every((a) => a.low < a.annual && a.annual < a.high)).toBe(true);
  });

  it('schedules the arrays — roof, facing, tilt, panels, kW and a year as a range — and leaves the other schedules as they were', () => {
    const m = readModel('s', SOLAR);
    const all = schedules(m, 'imperial');
    const solar = all.find((s) => s.id === 'solar')!;
    expect(solar.rows.map((r) => [r.cells['id']!.text, r.cells['roof']!.text, r.cells['facing']!.text, r.cells['panels']!.text, r.cells['inverter']!.text])).toEqual([
      ['PV1', 'East wing shed roof', 'E', '35', 'INV1'],
      ['PV2', 'Guest wing shed roof', 'N', '15', 'INV1'],
    ]);
    expect(solar.rows[0]!.cells['kwh']!.text).toMatch(/^\d{1,3}(,\d{3})*–\d{1,3}(,\d{3})*$/);
    expect(solar.footnote).toContain('not a production guarantee');
    const before = schedules(readModel('h', STREET), 'imperial');
    expect(before.find((s) => s.id === 'solar')).toBeUndefined();
    for (const s of before.filter((x) => x.id !== 'receptacles')) expect(all.find((x) => x.id === s.id)).toEqual(s);
  });
});
