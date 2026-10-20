/**
 * FLR-T-15.1: the ground in 3D — the Courtyard House on its lot. The grid follows the surveyed surface,
 * sits at each graded outline's elevation inside it and grades back to the ground at 1:4 outside it,
 * records where it cut and where it filled, is closed round its edge by a skirt, and carries contours
 * of the ground as it ends up; the same arrays every time.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gradeAt, siteDrawing, type FloorspecDocument } from '@floorspec/engine';
import { terrainMesh } from '../src/index.js';

const LOT = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8')) as FloorspecDocument;
const BU = 1_280_000;
const FT = 390_144;
const IN = 32_512;

describe('terrainMesh', () => {
  const site = siteDrawing(LOT);
  const origin = [12 * FT, 12 * FT, 0] as const;
  const t = terrainMesh(site, { origin })!;
  const grid = t.columns * t.rows;
  const at = (k: number) => [t.positions[k * 3]!, t.positions[k * 3 + 1]!, t.positions[k * 3 + 2]!] as const;

  it('follows the surveyed ground away from the house', () => {
    let checked = 0;
    for (let k = 0; k < grid; k += 97) {
      const [x, y, z] = at(k);
      const g = gradeAt(site.surface!, x * BU + origin[0], y * BU + origin[1]);
      if (g === undefined || t.change[k] !== 0) continue;
      expect(z).toBeCloseTo(g / BU, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('sits at the pad under the house and the slab under the walk, and records the cut and the fill', () => {
    const pad = site.graded.find((g) => g.id === 'PAD1')!;
    const walk = site.graded.find((g) => g.id === 'SL4C')!;
    const near = (x: number, y: number) => {
      let best = 0;
      let d = Infinity;
      for (let k = 0; k < grid; k++) {
        const [px, py] = at(k);
        const e = Math.hypot(px - (x - origin[0]) / BU, py - (y - origin[1]) / BU);
        if (e < d) {
          d = e;
          best = k;
        }
      }
      return best;
    };
    const inHouse = near(40 * FT, 50 * FT);
    expect(at(inHouse)[2]).toBeCloseTo(pad.elevation / BU, 5);
    expect(pad.elevation).toBe(-8 * IN);
    const onWalk = near(-25 * FT, 28 * FT);
    expect(at(onWalk)[2]).toBeCloseTo(walk.elevation / BU, 5);
    // the walk's bottom step is above the bank: filled; the house's east end is cut into the slope
    expect(t.change[onWalk]).toBeGreaterThan(0);
    expect(t.change[near(60 * FT, 40 * FT)]).toBeLessThan(0);
  });

  it('is closed by a skirt to its lowest ground, and carries contours', () => {
    expect(t.indices.length % 3).toBe(0);
    expect(t.indices.reduce((m, v) => Math.max(m, v), 0)).toBe(t.positions.length / 3 - 1);
    expect(t.low).toBeLessThan(-1.2);
    expect(t.high).toBeGreaterThan(0.6);
    expect(t.contours.length + t.majors.length).toBeGreaterThan(300);
    expect((t.contours.length + t.majors.length) % 6).toBe(0);
  });

  it('is the same every time, and nothing for a site with no surface', () => {
    const again = terrainMesh(siteDrawing(LOT), { origin })!;
    expect(Buffer.from(again.positions.buffer).equals(Buffer.from(t.positions.buffer))).toBe(true);
    const flat = structuredClone(LOT) as FloorspecDocument & { extensions: Record<string, { spots?: unknown; contours?: unknown }> };
    flat.extensions.FS_site!.spots = {};
    flat.extensions.FS_site!.contours = {};
    expect(terrainMesh(siteDrawing(flat), { origin })).toBeNull();
  });
});
