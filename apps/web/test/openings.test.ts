import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import type { FloorspecDocument } from '@floorspec/engine';
import {
  clearOpeningOf,
  clearOpeningText,
  formatClearArea,
  hingeApplies,
  holdsClearOpenings,
  operationOptions,
  parseClearArea,
  pausedExtensions,
  setClearOpening,
  setOperation,
  swingApplies,
  upgradePauses,
  upgradeTo03,
} from '../src/editor/openings';

/** Core 0.3's door and window data as the editor reads and writes it — each batch through the real applier. */

const IN = 32_512;
const TEMPLATE = JSON.parse(readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8')) as FloorspecDocument;
const as02 = { ...TEMPLATE, floorspec: '0.2' } as FloorspecDocument;

function commit(doc: object, batch: ReturnType<typeof upgradeTo03>): FloorspecDocument {
  const r = apply(doc, { batch });
  if (r.status !== 'committed') throw new Error(r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
  return JSON.parse(r.document) as FloorspecDocument;
}

describe('door and window data (Core 0.3)', () => {
  it('is held by a 0.3 plan, and a 0.2 plan gets it by one op that changes nothing else', () => {
    expect(holdsClearOpenings(TEMPLATE)).toBe(true);
    expect(holdsClearOpenings(as02)).toBe(false);
    const up = commit(as02, upgradeTo03());
    expect(up).toEqual(TEMPLATE);
  });

  it('says which official extensions an upgrade pauses, and which a 0.3 plan has paused', () => {
    const uses = { ...as02, extensionsUsed: { FS_electrical: '0.1.0', EXT_x: '1.0' } } as FloorspecDocument;
    expect(upgradePauses(uses)).toEqual(['FS_electrical']);
    expect(pausedExtensions(uses)).toEqual([]);
    expect(pausedExtensions({ ...uses, floorspec: '0.3' })).toEqual(['FS_electrical']);
  });

  it('sets and unsets an operation, and a clear opening whole', () => {
    let doc = commit(TEMPLATE, [...setOperation('D32', 'pocket', false), ...setClearOpening('D32', { width: 29 * IN, height: 79 * IN }, false)]);
    expect(doc.types?.['D32']).toMatchObject({ operation: 'pocket', clearOpening: { width: 29 * IN, height: 79 * IN } });
    const bd = doc.openings?.['BD'];
    expect(bd && clearOpeningOf(doc, bd)).toEqual({ width: 29 * IN, height: 79 * IN });
    doc = commit(doc, [...setOperation('D32', '', true), ...setClearOpening('D32', undefined, true)]);
    expect(doc.types?.['D32']).not.toHaveProperty('operation');
    expect(doc.types?.['D32']).not.toHaveProperty('clearOpening');
    expect(setOperation('D32', '', false)).toEqual([]);
    expect(setClearOpening('D32', undefined, false)).toEqual([]);
  });

  it('lists the operations of the kind, after "not declared"', () => {
    expect(operationOptions('doorType').map((o) => o.value)).toEqual(['', 'swing', 'doubleSwing', 'doubleActing', 'bypassSlide', 'pocket', 'surfaceSlide', 'bifold', 'overhead', 'cased']);
    expect(operationOptions('windowType')[1]).toEqual({ value: 'fixed', label: 'Fixed' });
    expect([hingeApplies(undefined), hingeApplies('swing'), hingeApplies('doubleSwing'), hingeApplies('pocket')]).toEqual([true, true, false, false]);
    expect([swingApplies('doubleSwing'), swingApplies('bifold')]).toEqual([true, false]);
  });

  it('reads and writes a clear area exactly, in either unit, never from width × height', () => {
    expect(parseClearArea('5.7', 'imperial')).toEqual({ ok: true, value: Math.round(5.7 * 144 * IN * IN) });
    expect(parseClearArea('0.53 m²', 'imperial')).toEqual({ ok: true, value: 868_352_000_000 });
    expect(parseClearArea('0', 'metric').ok).toBe(false);
    expect(parseClearArea('wide', 'metric').ok).toBe(false);
    expect(formatClearArea(6 * 144 * IN * IN, 'imperial')).toBe('6.00 ft²');
    expect(formatClearArea(868_352_000_000, 'metric')).toBe('0.530 m²');
    expect(clearOpeningText({ width: 20 * IN, height: 44 * IN }, 'imperial')).toBe('1\'-8" × 3\'-8"');
  });
});
