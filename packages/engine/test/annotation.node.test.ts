/**
 * FS_annotation's resolver (resolveAnnotations): what the editor, render2d and the PDF draw from.
 * Its lengths must be the derived ones, always — checked against every case of the vendored suite —
 * and its anchors must sit where FS_annotation's chapter 4 draws them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, measureDimension, OFFICIAL_EXTENSIONS, resolveAnnotations, resolveAnnotationsOf, evaluate, type Derived, type FloorspecDocument } from '../src/index.js';

const suite = join(import.meta.dirname, '..', 'standard', 'conformance', 'ext', 'FS_annotation', '0.1.0');
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const house = (): FloorspecDocument => structuredClone(read(join(suite, 'examples', '001-p13-house-with-annotation', 'input.json'))) as FloorspecDocument;
const reader = { extensions: ['FS_annotation'], knownExtensions: OFFICIAL_EXTENSIONS };
const FT = 390144;
const MM50 = 64000;

function derivedOf(doc: FloorspecDocument): Derived {
  const r = check(doc, reader);
  expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
  return r.derived!;
}

type Dims = Record<string, { level: string; lengths: number[] | null; total: number | null }>;
const anno = (doc: FloorspecDocument): { dimensions: Record<string, unknown>; notes: Record<string, unknown> } =>
  (doc.extensions as Record<string, { dimensions: Record<string, unknown>; notes: Record<string, unknown> }>)['FS_annotation']!;

describe('resolveAnnotations', () => {
  it('draws exactly the lengths FS_annotation derives, in every valid case of its suite without design options', () => {
    let n = 0;
    for (const group of readdirSync(suite).filter((g) => g !== 'ops' && g !== 'options')) {
      for (const c of readdirSync(join(suite, group))) {
        const dir = join(suite, group, c);
        if (!existsSync(join(dir, 'expected.json')) || existsSync(join(dir, 'design.json'))) continue;
        const exp = read(join(dir, 'expected.json')) as { valid: boolean; derived?: Derived & { extensions?: { FS_annotation?: { dimensions: Dims } } } };
        const dims = exp.derived?.extensions?.FS_annotation?.dimensions;
        if (!exp.valid || !dims) continue;
        const doc = read(join(dir, 'input.json')) as FloorspecDocument;
        const r = resolveAnnotations(doc, exp.derived);
        for (const [id, d] of Object.entries(dims)) {
          if (d.lengths === null) expect(r.unresolved, `${group}/${c} ${id}`).toContain(id);
          else {
            const got = r.dimensions.find((x) => x.id === id);
            expect({ lengths: got?.lengths, total: got?.total }, `${group}/${c} ${id}`).toEqual({ lengths: d.lengths, total: d.total });
          }
        }
        expect(r.dimensions.length + r.unresolved.length).toBe(Object.keys(dims).length);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(50);
  });

  it('places the overall string: features on the faces and the junction, points on the line, positions from the first', () => {
    const doc = house();
    const r = resolveAnnotations(doc, derivedOf(doc));
    const dm1 = r.dimensions.find((d) => d.id === 'DM1')!;
    expect(dm1).toEqual({
      id: 'DM1',
      level: 'L1',
      name: 'Overall, south',
      direction: [1, 0],
      anchors: [
        // W1's outside face, clamped to its extent: its south end, at the mitre with W7
        { feature: [-MM50, -MM50], onLine: [-MM50, -1536000], along: 0 },
        { feature: [12 * FT, 0], onLine: [12 * FT, -1536000], along: 12 * FT + MM50 },
        { feature: [20 * FT + MM50, -MM50], onLine: [20 * FT + MM50, -1536000], along: 20 * FT + 2 * MM50 },
      ],
      lengths: [12 * FT + MM50, 8 * FT + MM50],
      total: 20 * FT + 2 * MM50,
    });
  });

  it("measures an opening to its centre, and a face crossing the line inside its extent where it crosses", () => {
    const doc = house();
    const r = resolveAnnotations(doc, derivedOf(doc));
    const dm2 = r.dimensions.find((d) => d.id === 'DM2')!;
    expect(dm2.anchors[1]).toEqual({ feature: [6 * FT, 12 * FT], onLine: [6 * FT, 12 * FT + 1536000], along: 6 * FT + MM50 });
    const dm3 = r.dimensions.find((d) => d.id === 'DM3')!;
    // W1's inside face and W8's west face both reach the line y = 3'
    expect(dm3.anchors.map((a) => a.feature)).toEqual([[MM50, 3 * FT], [12 * FT - MM50, 3 * FT]]);
    expect(dm3.lengths).toEqual([12 * FT - 2 * MM50]);
  });

  it('runs along the direction, signed, and backwards for anchors out of order', () => {
    const doc = house();
    anno(doc).dimensions['DM5'] = { level: 'L1', direction: [-1, 0], through: [0, -FT], anchors: [{ junction: 'J6' }, { junction: 'J1' }, { junction: 'J5' }] };
    const r = resolveAnnotations(doc, derivedOf(doc));
    const dm5 = r.dimensions.find((d) => d.id === 'DM5')!;
    expect(dm5.anchors.map((a) => a.along)).toEqual([0, 12 * FT, -8 * FT]);
    expect(dm5.lengths).toEqual([12 * FT, 20 * FT]);
    expect(dm5.total).toBe(8 * FT);
  });

  it('lists the strings it cannot measure, and keeps a level only when asked', () => {
    const doc = house();
    anno(doc).dimensions['DM5'] = { level: 'L1', direction: [1, 0], through: [0, 0], anchors: [{ junction: 'J1' }, { junction: 'J99' }] };
    anno(doc).dimensions['DM6'] = { level: 'L1', direction: [1, 0], through: [0, 0], anchors: [{ junction: 'J1' }, { wall: 'W2', face: 'left' }] };
    const derived = derivedOf(doc);
    const r = resolveAnnotations(doc, derived);
    expect(r.unresolved).toEqual(['DM5', 'DM6']);
    expect(r.dimensions.map((d) => d.id)).toEqual(['DM1', 'DM2', 'DM3', 'DM4']);
    expect(r.notes).toEqual([
      { id: 'NT1', level: 'L1', text: 'Verify the rough opening on site\nbefore ordering the window.', at: [2 * FT, 15 * FT], leader: [6 * FT, 12 * FT], about: 'O1' },
      { id: 'NT2', level: 'L1', text: "Keep the panel's working space clear.", at: [13 * FT, FT], leader: [20 * FT - 128000, 3 * FT], about: 'X1' },
    ]);
    expect(resolveAnnotations(doc, derived, 'L2')).toEqual({ dimensions: [], notes: [], unresolved: [] });
  });

  it('reads leniently: malformed strings are unresolved, malformed notes and data are skipped', () => {
    const doc = house();
    anno(doc).dimensions['DM5'] = { level: 'L1', direction: [1, 0], anchors: [] };
    anno(doc).notes['NT3'] = { level: 'L1', text: 7 };
    const r = resolveAnnotations(doc, undefined);
    expect(r.unresolved).toEqual(['DM5']);
    expect(r.notes.map((n) => n.id)).toEqual(['NT1', 'NT2']);
    // without derived walls, a face anchor's feature is its crossing
    expect(r.dimensions.find((d) => d.id === 'DM1')!.anchors[0]!.feature).toEqual([-MM50, -1536000]);
    (doc.extensions as Record<string, unknown>)['FS_annotation'] = 'notes';
    expect(resolveAnnotations(doc, undefined)).toEqual({ dimensions: [], notes: [], unresolved: [] });
  });

  it('takes an evaluation for its view', () => {
    const doc = house();
    const ev = evaluate(doc, reader);
    expect(resolveAnnotationsOf(ev, derivedOf(doc)).dimensions).toHaveLength(4);
  });
});

describe('measureDimension', () => {
  it('rounds once, and never adds up rounded segments', () => {
    const doc = house();
    const m = measureDimension(doc, { level: 'L1', direction: [1, 2], through: [0, 0], anchors: [0, 1, 2, 3].map((k) => ({ point: [k, 0] as [number, number] })) as never });
    expect('lengths' in m && [m.lengths, m.total]).toEqual([[0n, 0n, 0n], 1n]);
  });

  it('is exact along an irrational diagonal', () => {
    const m = measureDimension(house(), { level: 'L1', direction: [1, 1], through: [0, 0], anchors: [{ junction: 'J1' }, { junction: 'J3' }] as never });
    // 12' x sqrt 2 = 6620963.23...
    expect('total' in m && m.total).toBe(6620963n);
  });

  it('says why a string cannot be measured', () => {
    expect(measureDimension(house(), { level: 'L1', direction: [1, 0], through: [0, 0], anchors: [{ junction: 'J9' }, { wall: 'W2', face: 'right' }] as never })).toEqual({ problems: ['missing', 'unmeasurable'] });
  });
});
