/**
 * Chapters 18 and 19 beyond what the suite compares: the texture space of a wall's face and of a
 * region (18.3, which the suite cannot test), a package looked up by exact path (18.4), and the
 * engine's design API — deriving one design, nothing for one that is not the document's (19.6).
 */
import { describe, expect, it } from 'vitest';
import { check, derive, DesignNotDerivedError, evaluate, Package, surfaceST, viewOf, type FloorspecDocument } from '../src/index.js';

const box = (extra: Record<string, unknown> = {}): FloorspecDocument =>
  ({
    floorspec: '0.3',
    project: { name: 't' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: 3456000 } },
    types: { WT: { kind: 'wallType', layers: [{ thickness: 128000, function: 'core' }] } },
    junctions: {
      J1: { level: 'L1', position: [0, 0] },
      J2: { level: 'L1', position: [0, 3840000] },
      J3: { level: 'L1', position: [5120000, 3840000] },
      J4: { level: 'L1', position: [5120000, 0] },
    },
    walls: {
      W1: { level: 'L1', start: 'J1', end: 'J2', type: 'WT' },
      W2: { level: 'L1', start: 'J2', end: 'J3', type: 'WT' },
      W3: { level: 'L1', start: 'J3', end: 'J4', type: 'WT' },
      W4: { level: 'L1', start: 'J4', end: 'J1', type: 'WT' },
    },
    rooms: { R1: { level: 'L1', anchor: [2560000, 1920000] } },
    ...extra,
  }) as unknown as FloorspecDocument;

describe('texture space (18.3)', () => {
  const doc = box();
  const region = { from: 768000, to: 4352000, bottom: 1170432 };
  it('measures a right face from the start junction, and a region of it from (from, bottom)', () => {
    const p: [number, number] = [768000, 3840000];
    expect(surfaceST(doc, 'W2', 'right', p, 1170432)).toEqual({ s: surfaceST(doc, 'W2', 'right', p, 1170432).s, t: 1170432n });
    expect(surfaceST(doc, 'W2', 'right', p, 1170432).s.toString()).toBe('768000');
    const r = surfaceST(doc, 'W2', 'right', p, 1170432, region);
    expect(r.s.sign()).toBe(0);
    expect(r.t).toBe(0n);
  });
  it("starts a region of a left face at (to, bottom): its lower corner on the viewer's left", () => {
    const r = surfaceST(doc, 'W2', 'left', [4352000, 3840000], 1170432, region);
    expect(r.s.sign()).toBe(0);
    expect(r.t).toBe(0n);
    expect(surfaceST(doc, 'W2', 'left', [768000, 3840000], 1170432, region).s.toString()).toBe('3584000');
  });
  it('is exact on an oblique wall: s is a surd', () => {
    const d = box({ junctions: { ...box().junctions, J3: { level: 'L1', position: [5120001, 3840002] } } });
    expect(surfaceST(d, 'W2', 'right', [5120001, 3840002], 0).s.isRational).toBe(false);
  });
});

describe('the package (18.4)', () => {
  it('names a file by its exact path, case and all', () => {
    const pkg = new Package({ 'assets/Tile.png': new Uint8Array([1, 2, 3]) });
    expect(pkg.file('assets/Tile.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(pkg.file('assets/tile.png')).toBeUndefined();
    expect(pkg.paths).toEqual(['assets/Tile.png']);
  });
});

describe('designs (19.6)', () => {
  const doc = box({
    optionSets: { KS: { primary: 'KA' } },
    options: { KA: { set: 'KS' }, KB: { set: 'KS' } },
    junctions: {
      ...box().junctions,
      J5: { level: 'L1', position: [1000000, 1000000], option: 'KB' },
      J6: { level: 'L1', position: [1000000, 2500000], option: 'KB' },
    },
    walls: { ...box().walls, WB: { level: 'L1', start: 'J5', end: 'J6', type: 'WT', option: 'KB' } },
  });
  it("derives the primary design without a design input, and option B's with one", () => {
    const a = derive(doc);
    expect(Object.keys(a.walls)).not.toContain('WB');
    expect(a.options!.KS!.chosen).toBe('KA');
    const b = derive(doc, { design: { KS: 'KB' } });
    expect(Object.keys(b.walls)).toContain('WB');
    expect(b.options!.KS!.chosen).toBe('KB');
    expect(b.options!.KS!.options.KB!.members).toEqual(['J5', 'J6', 'WB']);
    expect(b.options!.KS!.options.KB!.affected).toContain('R1');
  });
  it('keeps the whole document as `document` and the design as `view`', () => {
    const ev = evaluate(doc, { design: { KS: 'KB' } });
    expect(ev.document!.walls!.WB).toBeDefined();
    expect(ev.view!.walls!.WB).toBeDefined();
    expect(evaluate(doc).view!.walls!.WB).toBeUndefined();
    expect(viewOf(doc, { KS: 'KA' }).options).toBeUndefined();
  });
  it('derives nothing for a design that is not the document’s, and says so', () => {
    expect(check(doc, { design: { KS: 'nope' } }).derived).toBeUndefined();
    expect(check(doc, { design: { KS: 'nope' } }).valid).toBe(true);
    expect(() => derive(doc, { design: { XX: 'KA' } })).toThrow(DesignNotDerivedError);
  });
});
