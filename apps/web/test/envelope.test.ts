/**
 * FLR-T-16.4: the editor's thermal envelope — the library's values written onto a plan that has none (one
 * batch, FS_thermal declared, the estimate then the plan's own), the estimate of the Courtyard House's
 * envelope room by room, and the words the panels use.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_READER } from '@floorspec/engine';
import { apply as applyLocally } from '@floorspec/ops';
import { readModel, type EditorModel } from '../src/editor/model';
import { addLibraryValues } from '../src/editor/envelope/Envelope';
import { envelopeEstimate, perAreaText, rIn, uIn, wattsRange } from '../src/editor/envelope/state';
import type { Batch } from '../src/editor/ops';

const PLAIN = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const ENVELOPE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house-envelope.json', import.meta.url), 'utf8');

function applied(model: EditorModel, batch: Batch): EditorModel {
  const r = applyLocally(model.document, { batch }, OFFICIAL_READER);
  expect(r.status, JSON.stringify(r.status === 'committed' ? [] : r.diagnostics)).toBe('committed');
  if (r.status !== 'committed') throw new Error('rejected');
  return readModel(r.hash, r.document);
}

describe('the thermal envelope in the editor', () => {
  it('adds the library’s values to a plan that has none, in one batch, and the estimate then uses them', () => {
    const m = readModel('h', PLAIN);
    const before = envelopeEstimate(m);
    expect(before.status === 'ok' && before.estimate.thermal).toBe(false);
    const batch = addLibraryValues(m.document);
    expect(batch[0]).toEqual({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_thermal', value: '0.1.0' });
    expect(batch.some((op) => (op as { id?: string }).id === 'gypsum-board')).toBe(true);
    const after = applied(m, batch);
    const e = envelopeEstimate(after);
    expect(e.status).toBe('ok');
    if (e.status !== 'ok') return;
    expect(e.estimate.thermal).toBe(true);
    const wall = e.estimate.assemblies.find((a) => a.key === 'wall:wall-2x6-exterior-fibre-cement')!;
    expect(['document', 'library']).toContain(wall.source);
    // Again: nothing left to add.
    expect(addLibraryValues(after.document)).toEqual([]);
  });

  it('estimates the Courtyard House room by room, in Atlanta', () => {
    const e = envelopeEstimate(readModel('h', ENVELOPE));
    expect(e.status).toBe('ok');
    if (e.status !== 'ok') return;
    expect(e.estimate.climate.station?.city).toBe('Atlanta, GA');
    const kitchen = e.estimate.rooms.find((r) => r.room === 'R8')!;
    expect(kitchen.name).toBe('Kitchen');
    expect(kitchen.heating).toBeGreaterThan(0);
    expect(kitchen.heatingParts.map((p) => p.kind)).toContain('walls');
    expect(e.estimate.surfaces.some((s) => s.kind === 'roof' && s.element === 'RF1')).toBe(true);
  });

  it('speaks in ranges and the trade’s units', () => {
    expect(wattsRange(2000, 'imperial')).toBe('5,500–8,200 Btu/h');
    expect(wattsRange(2000, 'metric')).toBe('1,600–2,400 W');
    expect(rIn(4.31, 'imperial')).toBe('R-24');
    expect(uIn(0.232, 'imperial')).toBe('U-0.041');
    expect(rIn(4.31, 'metric')).toBe('RSI 4.3');
    expect(perAreaText(12, 'imperial')).toBe('12 Btu/h per ft²');
  });
});
