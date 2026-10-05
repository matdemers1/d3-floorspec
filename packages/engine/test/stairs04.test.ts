/**
 * Core 0.4 stairs (17.6, 17.7) by hand: winders of 30° about the inner corner of a quarter turn and
 * around a newel, a spiral's goings on its walkline and at its column, the exact rounding of a going
 * and of an arc, FS-INV-905, FS-INV-906, FS-LINT-018 and FS-LINT-019, the opening a stair with a
 * minHeadroom needs, and a Core 0.3 reader that steps none of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, validate } from '../src/index.js';
import { roundArc } from '../src/exact/angle.js';
import { Surd } from '../src/exact/surd.js';
import { roundSqrt, type DerivedStair } from '../src/stairs/stairs.js';

const MM = 1280;
const suite = join(import.meta.dirname, '..', 'standard', 'conformance', 'core', '0.4', 'stairs');
type StairDoc = Record<string, unknown> & { stairs: { ST1: Record<string, unknown> & { form: Record<string, unknown> } } };
const input = (name: string): StairDoc => JSON.parse(readFileSync(join(suite, name, 'input.json'), 'utf8')) as StairDoc;
const stairOf = (doc: unknown): DerivedStair => (check(doc as object).derived as { stairs: Record<string, DerivedStair> }).stairs.ST1!;
const codes = (doc: unknown, core?: '0.3' | '0.4') => validate(doc as object, core ? { core } : {}).diagnostics.map((d) => `${d.code} ${d.elements.join(',')}`);

describe('exact goings and arcs (17.7)', () => {
  it('rounds a square root exactly, ties to even', () => {
    expect(roundSqrt(Surd.of(25n, 4n))).toBe(2n); // 2.5
    expect(roundSqrt(Surd.of(49n, 4n))).toBe(4n); // 3.5
    expect(roundSqrt(Surd.of(2n))).toBe(1n);
    expect(roundSqrt(Surd.sqrt(2n).mulInt(8n))).toBe(3n); // √(8√2) ≈ 3.36
  });
  it('rounds an arc with π once', () => {
    expect(roundArc(0n, 1n, 1n, 1n, 180_000_000n)).toBe(3n);
    expect(roundArc(0n, 1n, BigInt(450 * MM), 1n, 90_000_000n)).toBe(904779n);
  });
});

describe('winder stairs (17.7)', () => {
  it('three winders of 30° about the inner corner: 900 sin 15 mm on the walkline, nothing at the corner', () => {
    const doc = { ...input('014-winder-quarter'), floorspec: '0.4' };
    const st = stairOf(doc);
    expect(st.steps!.filter((s) => s.winder)).toHaveLength(3);
    expect(st.walklineGoing).toBe(Math.round(900 * MM * Math.sin(Math.PI / 12)));
    expect(st.narrowGoing).toBe(0);
    expect(st.walkline!.length).toBe(4104779);
    expect(st.run).toBe(st.walkline!.length);
    expect(codes(doc)).toContain('FS-LINT-018 ST1');
  });
  it('a newel gives the winders a narrow end: 100 tan 30 mm', () => {
    const st = stairOf(input('050-winder-with-newel'));
    expect(st.narrowGoing).toBe(Math.round(100 * MM * Math.tan(Math.PI / 6)));
    expect(st.steps![3]!.outline).toEqual([
      [2240000, 192000],
      [2905108, 192000],
      [2313901, 1216000],
      [2240000, 1216000],
    ]);
  });
  it('a right turn is the mirror image', () => {
    const left = input('050-winder-with-newel');
    const right = structuredClone(left);
    right.stairs.ST1.form.turn = 'right';
    right.stairs.ST1.position = [1000 * MM, 3400 * MM];
    const a = stairOf(left);
    const b = stairOf(right);
    expect(b.walklineGoing).toBe(a.walklineGoing);
    expect(b.narrowGoing).toBe(a.narrowGoing);
  });
  it('FS-INV-905: a newel that reaches the walkline', () => {
    const doc = input('050-winder-with-newel');
    doc.stairs.ST1.form.newel = 320 * MM;
    expect(codes(doc)).toEqual(['FS-INV-905 ST1']);
  });
});

describe('spiral stairs (17.7)', () => {
  it('goings on the walkline and at the column, and its centre', () => {
    const st = stairOf(input('057-spiral-under-a-floor'));
    const half = Math.PI / 16; // half of 22.5°
    expect(st.centre).toEqual([2560000, 1920000]);
    expect(st.walklineGoing).toBe(Math.round(2 * 500 * MM * Math.sin(half)));
    expect(st.narrowGoing).toBe(Math.round(2 * 100 * MM * Math.sin(half)));
    expect(st.headroom).toBe(2008615);
    expect(st.steps).toHaveLength(12);
  });
  it('FS-INV-906: a tread of half a turn', () => {
    const doc = input('057-spiral-under-a-floor');
    doc.stairs.ST1.risers = 3;
    doc.stairs.ST1.form.sweep = 360_000_000;
    expect(codes(doc)).toEqual(['FS-INV-906 ST1']);
  });
});

describe('the opening and the headroom it is cut for (17.6)', () => {
  it('starts at the first step less than minHeadroom below the floor above; FS-LINT-019 when the headroom is less', () => {
    expect(stairOf(input('058-opening')).opening).toEqual({ first: 3 });
    expect(stairOf(input('059-headroom-less-than-declared')).opening).toEqual({ first: 2 });
    expect(codes(input('059-headroom-less-than-declared'))).toContain('FS-LINT-019 ST1');
  });
});

describe('a Core 0.3 reader', () => {
  it('derives no winder steps, and reports FS-LINT-016', () => {
    const doc = input('014-winder-quarter');
    const r = check({ ...doc, floorspec: '0.3' }, { core: '0.3' });
    expect((r.derived as { stairs: Record<string, DerivedStair> }).stairs.ST1!.steps).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('FS-LINT-016');
  });
});
