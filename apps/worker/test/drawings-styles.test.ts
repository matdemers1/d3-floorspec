/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportPdf, type Sheet } from '../src/export/drawings/index.js';
import type { Prim } from '../src/export/drawings/sheet.js';
import { BLUEPRINT, patternJoints } from '../src/export/drawings/styles.js';
import { exportParams } from '../src/queue/handlers.js';

/**
 * FLR-T-18.5: a PDF in a plan style. The Courtyard House's main floor as a colour sheet — its floors
 * in their finishes' colours with their joints clipped to each room, its patio in bluestone, its
 * furniture in colour — as a technical sheet with its exterior walls hatched, and as a blueprint.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const VERSION = { hash: '3c9e1f0a71fe5b0c2d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c', seq: 58, at: new Date('2026-10-14T12:00:00Z') };
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-styles-'));

const prims = (s: Sheet): Prim[] => {
  const out: Prim[] = [];
  const walk = (ps: readonly Prim[]): void => {
    for (const p of ps) {
      out.push(p);
      if (p.t === 'clip') walk(p.children);
    }
  };
  walk(s.prims);
  return out;
};
const fills = (s: Sheet): Set<string> => new Set(prims(s).flatMap((p) => (p.t === 'path' && p.fill !== undefined ? [p.fill] : [])));

describe('drawings in a plan style (FLR-T-18.5)', { timeout: 120_000 }, () => {
  it('reads a job’s style, keeping only one it knows', () => {
    expect(exportParams({ versionAt: '2026-10-14T00:00:00Z', style: 'colour' })).toMatchObject({ style: 'colour' });
    expect(exportParams({ versionAt: '2026-10-14T00:00:00Z', style: 'sepia' })).not.toHaveProperty('style');
  });

  it('a floor’s joints across a room: boards staggered, tile in a grid, none too fine to see', () => {
    const square: [number, number][] = [[0, 0], [390_144 * 4, 0], [390_144 * 4, 390_144 * 4], [0, 390_144 * 4]];
    const boards = patternJoints({ kind: 'plank', width: 7 * 32_512, length: 60 * 32_512, gap: 0 }, 0, square, 1000);
    expect(boards.length).toBeGreaterThan(8);
    const tile = patternJoints({ kind: 'tile', w: 390_144, h: 390_144, grout: 3840, bond: 'grid' }, 0, square, 1000);
    expect(tile.length).toBeGreaterThanOrEqual(8);
    expect(patternJoints({ kind: 'plank', width: 7 * 32_512, length: 60 * 32_512, gap: 0 }, 0, square, 1e9)).toEqual([]);
    expect(patternJoints({ kind: 'carpet' }, 0, square, 1)).toEqual([]);
  });

  it('a colour sheet: the floors in their finishes, the patio in bluestone, furniture in colour; the plain sheet has none of it', async () => {
    const plain = await exportPdf(HOUSE, { version: VERSION, fontDir, viewDpi: 48, levels: ['L1'] });
    const colour = await exportPdf(HOUSE, { version: VERSION, fontDir, viewDpi: 48, levels: ['L1'], style: 'colour' });
    const f = fills(colour.sheets[0]!);
    // White oak, porcelain, terrazzo, epoxy, bluestone — the materials' own colours.
    for (const c of ['#b9a283', '#b9aa95', '#dfe1dd', '#8c9196', '#5f666a']) expect(f.has(c), c).toBe(true);
    expect(f.has('#8f9bb2')).toBe(true);
    expect(fills(plain.sheets[0]!).has('#b9a283')).toBe(false);
    // Joints clipped to the rooms.
    expect(prims(colour.sheets[0]!).filter((p) => p.t === 'clip').length).toBeGreaterThan(prims(plain.sheets[0]!).filter((p) => p.t === 'clip').length);
    expect(colour.bytes.byteLength).toBeGreaterThan(0);
  });

  it('a blueprint: the plan white on blueprint blue', async () => {
    const pdf = await exportPdf(HOUSE, { version: VERSION, fontDir, viewDpi: 48, levels: ['L1'], style: 'blueprint' });
    const f = fills(pdf.sheets[0]!);
    expect(f.has(BLUEPRINT.paper)).toBe(true);
    expect(f.has(BLUEPRINT.ink)).toBe(true);
  });
});
