/** Display (9.6), the test grammar's comparisons (3.8) and typing (3.9), beyond the conformance suite. */
import { describe, expect, it } from 'vitest';
import { displayArea, displayLength, displayThreshold, displayValue, typeRule, valueOk, type Rule } from '../src/index.js';
import { compare } from '../src/evaluation.js';

describe('display (9.6)', () => {
  it('writes lengths in feet, inches and sixteenths, or millimetres, rounded once', () => {
    expect(displayLength(390144n, 'imperial')).toBe("1' 0\"");
    expect(displayLength(1148080n, 'imperial')).toBe("2' 11 5/16\"");
    expect(displayLength(0n, 'imperial')).toBe("0' 0\"");
    expect(displayLength(-390144n - 16256n, 'imperial')).toBe("-1' 0 1/2\"");
    // 1,016 base units is exactly half a sixteenth: ties go to even (0).
    expect(displayLength(1016n, 'imperial')).toBe("0' 0\"");
    expect(displayLength(3048n, 'imperial')).toBe("0' 0 1/8\""); // 1.5 sixteenths → 2
    expect(displayLength(1732n * 1280n, 'metric')).toBe('1732 mm');
    expect(displayLength(640n, 'metric')).toBe('0 mm'); // half a millimetre, to even
  });

  it('writes areas in hundredths of a square foot or metre, from the doubled exact area', () => {
    expect(displayArea(2n * 152212340736n, 'imperial')).toBe('1.00 sq ft');
    expect(displayArea(2n * 152212340736n * 57n / 10n, 'imperial')).toBe('5.70 sq ft');
    expect(displayArea(2n * 1638400000000n * 53n / 100n, 'metric')).toBe('0.53 m²');
    expect(displayArea(25n, 'imperial')).toBe('0.00 sq ft');
  });

  it('writes counts, integers with units, booleans, terms, and no value', () => {
    expect(displayValue('count', 3n, 'imperial')).toBe('3');
    expect(displayValue('integer', 20n, 'metric', 'A')).toBe('20 A');
    expect(displayValue('boolean', true, 'imperial')).toBe('yes');
    expect(displayValue('boolean', false, 'imperial')).toBe('no');
    expect(displayValue('term', 'sleeping', 'imperial')).toBe('sleeping');
    expect(displayValue('terms', ['usb', 'gfci'], 'imperial')).toBe('gfci, usb');
    expect(displayValue('terms', [], 'imperial')).toBe('none');
    expect(displayValue('integer', null, 'imperial')).toBe('not stated');
  });

  it('writes thresholds as values of the measure’s type: each of `in`, an area’s square base units', () => {
    expect(displayThreshold('length', 'in', [390144, 780288], 'imperial')).toBe("1' 0\", 2' 0\"");
    expect(displayThreshold('area', '>=', 152212340736, 'imperial')).toBe('1.00 sq ft');
    expect(displayThreshold('terms', 'has', 'gfci', 'imperial')).toBe('gfci');
    expect(displayThreshold('boolean', '=', false, 'imperial')).toBe('no');
    expect(displayThreshold('integer', '>=', 20, 'imperial', 'A')).toBe('20 A');
  });
});

describe('comparisons (3.8)', () => {
  it('compares numbers exactly by every operator', () => {
    const cases: [string, number, boolean][] = [
      ['<', 6, true],
      ['<', 5, false],
      ['<=', 5, true],
      ['>', 4, true],
      ['>', 5, false],
      ['>=', 5, true],
      ['=', 5, true],
      ['!=', 5, false],
      ['!=', 4, true],
    ];
    for (const [op, t, want] of cases) expect([op, t, compare('length', 5n, op, t)]).toEqual([op, t, want]);
    expect(compare('count', 2n, 'in', [1, 2, 3])).toBe(true);
    expect(compare('count', 4n, 'in', [1, 2, 3])).toBe(false);
  });

  it('compares an area as the exact multiple of a half it is', () => {
    // "12.5", held doubled as 25.
    expect(compare('area', 25n, '<', 13)).toBe(true);
    expect(compare('area', 25n, '>', 12)).toBe(true);
    expect(compare('area', 25n, '=', 12)).toBe(false);
    expect(compare('area', 24n, '=', 12)).toBe(true);
    expect(compare('area', 24n, '>=', 12)).toBe(true);
  });

  it('compares terms, booleans and term sets', () => {
    expect(compare('term', 'door', '=', 'door')).toBe(true);
    expect(compare('term', 'door', '!=', 'door')).toBe(false);
    expect(compare('term', 'door', 'in', ['window', 'door'])).toBe(true);
    expect(compare('boolean', false, '=', false)).toBe(true);
    expect(compare('boolean', true, '!=', false)).toBe(true);
    expect(compare('terms', ['gfci', 'usb'], 'has', 'gfci')).toBe(true);
    expect(compare('terms', [], 'has', 'gfci')).toBe(false);
  });

  it('a measure with no value equals nothing: every condition fails but !=', () => {
    for (const op of ['<', '<=', '>', '>=', '=', 'in']) expect(compare('integer', null, op, op === 'in' ? [1] : 1)).toBe(false);
    expect(compare('integer', null, '!=', 1)).toBe(true);
    expect(compare('terms', null, 'has', 'gfci')).toBe(false);
  });
});

describe('typing (3.9)', () => {
  const base = (over: Partial<Rule> = {}): Rule => ({
    title: 'A synthetic rule',
    citation: { code: 'TEST-CODE', edition: '2024', section: '1.1' },
    paraphrase: 'Synthetic.',
    applies: { to: 'room' },
    requirement: { measure: 'roomNetArea', op: '>=', value: 1 },
    severity: 'mayNotMeet',
    provenance: { verifiedBy: 'test', verifiedOn: '2026-10-05', edition: '2024' },
    ...over,
  });

  it('accepts a well-typed rule', () => {
    expect(typeRule(base())).toEqual({ ok: true, deferred: false, reads: new Set() });
  });

  it('refuses a measure of another kind of target, unknown arguments, a missing argument, and a value of the wrong kind', () => {
    expect(typeRule(base({ requirement: { measure: 'openingWidth', op: '>=', value: 1 } })).ok).toBe(false);
    expect(typeRule(base({ requirement: { measure: 'roomNetArea', args: { x: 1 }, op: '>=', value: 1 } })).ok).toBe(false);
    expect(typeRule(base({ requirement: { measure: 'roomAdjacentTo', op: '=', value: true } })).ok).toBe(false);
    expect(typeRule(base({ requirement: { measure: 'roomAdjacentTo', args: { function: 'nope' }, op: '=', value: true } })).ok).toBe(false);
    expect(typeRule(base({ requirement: { measure: 'roomNetArea', op: 'in', value: [1, 2] } })).ok).toBe(false);
    expect(typeRule(base({ requirement: { measure: 'roomFunction', op: '<', value: 1 } })).ok).toBe(false);
    expect(typeRule(base({ requirement: { measure: 'roomIsEntry', op: '=', value: 'yes' } })).ok).toBe(false);
  });

  it('refuses extension or collection on a subject that is not an element, and a collection without an extension', () => {
    expect(typeRule(base({ applies: { to: 'room', extension: 'FS_electrical' } })).ok).toBe(false);
    expect(typeRule(base({ applies: { to: 'element', collection: 'panels' }, requirement: { measure: 'elementTopAboveFloor', op: '>', value: 0 } })).ok).toBe(false);
  });

  it('refuses a candidate set of another subject kind, or with arguments it does not take', () => {
    expect(typeRule(base({ select: { from: 'envelopes', need: 'any' }, requirement: { measure: 'envelopeDepth', op: '>', value: 0 } })).ok).toBe(false);
    expect(typeRule(base({ select: { from: 'openings', args: { to: 'inside' }, need: 'any' }, requirement: { measure: 'openingWidth', op: '>', value: 0 } })).ok).toBe(false);
    expect(typeRule(base({ select: { from: 'openings', args: { to: 'outside' }, need: 'any' }, requirement: { measure: 'openingWidth', op: '>', value: 0 } })).ok).toBe(true);
  });

  it('allows elementMember only on elements of an extension the rule names, and says it reads it', () => {
    const member = { measure: 'elementMember', args: { name: 'amps', type: 'integer', unit: 'A' }, op: '>=' as const, value: 20 };
    expect(typeRule(base({ applies: { to: 'element' }, requirement: member })).ok).toBe(false);
    expect(typeRule(base({ applies: { to: 'element', extension: 'FS_electrical', collection: 'receptacles' }, requirement: member }))).toEqual({
      ok: true,
      deferred: false,
      reads: new Set(['FS_electrical']),
    });
    expect(typeRule(base({ select: { from: 'elements', args: { extension: 'FS_electrical' }, need: 'all' }, requirement: member })).reads).toEqual(new Set(['FS_electrical']));
    // A unit only with an integer.
    expect(typeRule(base({ applies: { to: 'element', extension: 'FS_electrical' }, requirement: { ...member, args: { name: 'amps', type: 'term', unit: 'A' }, value: 'x' } })).ok).toBe(false);
  });

  it('says which extensions a measure reads: with a match, or always', () => {
    expect(typeRule(base({ requirement: { measure: 'elementCount', args: { extension: 'FS_plumbing' }, op: '>=', value: 1 } })).reads).toEqual(new Set());
    expect(typeRule(base({ requirement: { measure: 'elementCount', args: { extension: 'FS_plumbing', match: { fixture: 'toilet' } }, op: '>=', value: 1 } })).reads).toEqual(
      new Set(['FS_plumbing']),
    );
    expect(typeRule(base({ requirement: { measure: 'circuitCount', op: '>=', value: 2 } })).reads).toEqual(new Set(['FS_electrical']));
  });

  it('marks a deferred measure, typed as anything, wherever it is used', () => {
    expect(typeRule(base({ requirement: { measure: 'ceilingHeight', args: { anything: true }, op: 'has', value: 'x' } }))).toEqual({ ok: true, deferred: true, reads: new Set() });
    expect(typeRule(base({ applies: { to: 'room', where: { not: { measure: 'travelDistance', op: '<', value: 1 } } } })).deferred).toBe(true);
  });

  it('refuses provenance that names another edition than the citation', () => {
    expect(typeRule(base({ provenance: { verifiedBy: 'test', verifiedOn: '2026-10-05', edition: '2021' } })).ok).toBe(false);
  });

  it('valueOk follows the table of 3.8', () => {
    expect(valueOk('length', 'in', [1, 2])).toBe(true);
    expect(valueOk('area', 'in', [1, 2])).toBe(false);
    expect(valueOk('terms', 'has', 'x')).toBe(true);
    expect(valueOk('terms', '=', 'x')).toBe(false);
    expect(valueOk('boolean', 'in', [true])).toBe(false);
    expect(valueOk('count', '>=', Number.NaN)).toBe(false); // a `1.0` in a request reads as NaN
  });
});
