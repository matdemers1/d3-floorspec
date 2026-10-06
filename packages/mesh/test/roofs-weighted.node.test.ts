/**
 * Core 0.4 roofs (16.4.3 to 16.4.6) as solids: a saltbox, whose attic is a prism under two planes at
 * two pitches, and an L-shaped hip with its wings at two pitches, both closed shells — and, with a
 * thickness, a saltbox's gable ends as parts of their own.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type Mesher } from '../src/index.js';
import { conformanceInputs } from './fixtures.js';

const FT = 390_144n;
let mesher: Mesher;
beforeAll(async () => {
  mesher = await loadMesher();
});

const input = (name: string): string => conformanceInputs().find((x) => x.name === `0.4/roofs/${name}`)!.text;

describe('roofs at mixed pitches (Core 0.4)', () => {
  it('a saltbox: a prism 34 ft long whose section is 26 ft deep and 26/3 ft high', () => {
    const roof = mesher.meshDocument(input('055-saltbox'), { include: ['roof'], stats: true }).parts[0]!;
    expect(roof.closed).toBe(true);
    // 6 V = 6 · (26 ft · 26/3 ft / 2) · 34 ft = 26 ft · 26 ft · 34 ft.
    expect(BigInt(roof.stats!.volume6!)).toBe(26n * FT * 26n * FT * 34n * FT);
    expect(roof.bbox.max[2]).toBe(3_456_000 + Number((26n * FT) / 3n));
  });
  it('an L-shaped hip with its wings at two pitches: one closed shell 9 ft high', () => {
    const roof = mesher.meshDocument(input('057-l-shaped-hip-at-two-pitches'), { include: ['roof'], stats: true }).parts[0]!;
    expect(roof.closed).toBe(true);
    expect(BigInt(roof.stats!.volume6!)).toBeGreaterThan(0n);
    expect(roof.bbox).toEqual({ min: [0, 0, 3_456_000], max: [Number(40n * FT), Number(48n * FT), 3_456_000 + Number(9n * FT)] });
  });
  it('a saltbox with a thickness: a slab under its two faces, and its gable ends apart', () => {
    const doc = JSON.parse(input('055-saltbox')) as { roofs: { RF1: Record<string, unknown> } };
    doc.roofs.RF1['thickness'] = 256_000;
    const parts = mesher.meshDocument(doc, { include: ['roof', 'roofGable'], stats: true }).parts;
    expect(parts.map((p) => p.kind).sort()).toEqual(['roof', 'roofGable', 'roofGable']);
    expect(parts.find((p) => p.kind === 'roof')!.closed).toBe(true);
  });
});
