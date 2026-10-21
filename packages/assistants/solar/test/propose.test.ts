import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { equatorRotation, proposeSolar, SolarError, type SolarProposal } from '../src/index.js';

/**
 * The solar assistant (FLR-T-16.1) on the Courtyard House on its street and on the conformance suite's sunny
 * house: it ranks the faces by a kW's year after shade, lays out the best within their setbacks, sizes to the
 * house's use, adds an inverter, an initiator and their circuit beside the panel, and the batch commits under
 * the reference applier as the server runs it — clear of every setback, deterministic, and never a guarantee.
 */

const read = (u: string): string => readFileSync(new URL(u, import.meta.url), 'utf8');
const STREET = read('../../../../apps/worker/test/fixtures/courtyard-house-on-its-street.json');
const SUNNY = read('../../../engine/standard/conformance/ext/FS_energy/0.1.0/examples/001-p16-sunny-house/input.json');
const HOUSE = read('../../../engine/standard/conformance/core/0.2/examples/001-three-room-house/input.json');

function commit(doc: string, p: SolarProposal): string {
  const r = apply(doc, { batch: p.batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

describe('the Courtyard House on its street', () => {
  const p = proposeSolar(STREET);
  const after = commit(STREET, p);

  it('ranks the faces — the east wing, the garage’s flat roof racked south, the guest wing facing north — and lays out the best, sized to the house’s use', () => {
    expect(p.faces.map((f) => [f.key, f.status])).toEqual([
      ['RF1:1', 'used'],
      ['RF3', 'skipped'],
      ['RF2:2', 'skipped'],
    ]);
    expect(p.faces[0]!.perKw).toBeGreaterThan(p.faces[1]!.perKw);
    expect(p.arrays).toHaveLength(1);
    expect(p.target?.source).toMatch(/^100% of the house’s/);
    expect(p.total.annual).toBeGreaterThanOrEqual(p.target!.kwh);
    expect(p.inverter?.id).toBe('INV1');
  });

  it('declares FS_energy first, and the batch commits valid, clear of every setback, the inverter and the initiator on one circuit', () => {
    expect(p.batch[0]).toEqual({ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_energy', value: '0.1.0' });
    const r = check(after, OFFICIAL_READER);
    expect(r.valid, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
    expect(r.diagnostics.filter((d) => d.code.startsWith('FS-ENGY'))).toEqual([]);
    const circuits = (JSON.parse(after) as { extensions: { FS_electrical: { circuits: Record<string, { loads: string[]; volts: number; breaker: number }> } } }).extensions.FS_electrical.circuits;
    const c = Object.values(circuits).find((x) => x.loads.includes('INV1'))!;
    expect(c.loads).toEqual(['INV1', 'RS1']);
    expect(c.volts).toBe(240);
    expect(c.breaker).toBeGreaterThanOrEqual(Math.ceil((p.inverter!.watts / 240) * 1.25));
  });

  it('says it is an estimate, never a guarantee, and never a code', () => {
    const words = [...p.explanation, p.advisory, p.method].join(' ');
    expect(words).toContain('not a production guarantee');
    expect(words).not.toMatch(/compliant/i);
  });

  it('is the same every time', () => {
    expect(JSON.stringify(proposeSolar(STREET).batch)).toBe(JSON.stringify(p.batch));
  });

  it('asked again, adds nothing on the face it used, and a target in kWh or filling sizes otherwise', () => {
    const again = proposeSolar(after);
    expect(again.faces.find((f) => f.key === 'RF1:1')?.reason).toBe('already has an array');
    const fill = proposeSolar(STREET, { target: { kind: 'fill' } });
    expect(fill.arrays.length).toBeGreaterThan(1);
    const small = proposeSolar(STREET, { target: { kind: 'kwh', kwh: 4000 } });
    expect(small.total.modules).toBeLessThan(p.total.modules);
    expect(small.total.annual).toBeGreaterThanOrEqual(4000);
  });

  it('lays an array on one face asked for, joining the plan’s inverter and initiator', () => {
    const one = proposeSolar(after, { faces: ['RF2:2'] });
    expect(one.arrays.map((a) => a.roof)).toEqual(['RF2']);
    const joined = one.batch.filter((o) => (o as { op: string }).op === 'setProperty');
    expect(joined.map((o) => (o as { id: string }).id)).toEqual(['INV1', 'RS1']);
    expect(check(commit(after, one), OFFICIAL_READER).diagnostics.filter((d) => d.code.startsWith('FS-ENGY'))).toEqual([]);
  });
});

describe('other plans', () => {
  it('fills the sunny house’s free face when every face is asked for, its corners clear', () => {
    const p = proposeSolar(SUNNY, { target: { kind: 'fill' }, cutoff: 0 });
    expect(p.faces.find((f) => f.key === 'RF1:0')?.reason).toBe('already has an array');
    const after = commit(SUNNY, p);
    expect(check(after, OFFICIAL_READER).diagnostics.filter((d) => d.code === 'FS-ENGY-LINT-001')).toEqual([]);
  });

  it('turns racks toward the equator: south in the north, north in the south', () => {
    expect(equatorRotation({ latitude: 40, latitudeSource: 'site', trueNorth: 0, zone: '4A', zoneSource: 'assumed', clearness: 0.54 })).toBe(-90_000_000);
    expect(equatorRotation({ latitude: -33, latitudeSource: 'site', trueNorth: 0, zone: '4A', zoneSource: 'assumed', clearness: 0.54 })).toBe(90_000_000);
  });

  it('refuses a plan with no roofs to carry an array', () => {
    expect(() => proposeSolar(HOUSE)).toThrow(SolarError);
    expect(() => proposeSolar(JSON.parse(HOUSE) as FloorspecDocument)).toThrow(/no roofs/);
  });
});
