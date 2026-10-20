/**
 * FLR-T-15.2: the ground opens for a sunken pool. The back terrace's plunge pool (its floor 5′ 6″ under
 * the ground) and its spa (raised 18″, but 2′ deep under the courtyard's floor) are holes; a pool
 * standing on the ground is not; and the terrain leaves out the cells inside a hole and keeps every other.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER, siteDrawing, type FloorspecDocument } from '@floorspec/engine';
import terrace from '../../engine/standard/conformance/ext/FS_outdoor/0.1.0/examples/001-p15-back-terrace/input.json' with { type: 'json' };
import { inHoles, insideRing, sunkenOutlines, terrainMesh } from '../src/index.js';

const IN = 32512;
const FT = 12 * IN;

describe('sunkenOutlines', () => {
  const ev = evaluate(structuredClone(terrace), OFFICIAL_READER);
  const derived = deriveEvaluation(ev);
  const doc = (ev.view ?? ev.document)!;
  const holes = sunkenOutlines(doc, derived);

  it("is every pool whose box goes below its frame's origin, as its footprint", () => {
    expect(holes.map((h) => h.id)).toEqual(['X1', 'X2']);
    const plunge = holes[0]!;
    expect(plunge.level).toBe('L1');
    expect(plunge.bottom).toBe(-66 * IN);
    // 8' x 14' centred at (7', -18')
    expect(insideRing(7 * FT, -18 * FT, plunge.ring)).toBe(true);
    expect(insideRing(7 * FT, -10 * FT, plunge.ring)).toBe(false);
    expect(inHoles(10.9 * FT, -24.9 * FT, holes.map((h) => h.ring))).toBe(true);
  });

  it('leaves out no pool that stands on the ground', () => {
    const d = structuredClone(terrace) as unknown as { extensions: { FS_outdoor: { collections: { pools: Record<string, { fallback: { box: { min: number[]; max: number[] } } }> } } } };
    const box = d.extensions.FS_outdoor.collections.pools['X1']!.fallback.box;
    box.max[2] = 66 * IN;
    box.min[2] = 0;
    const e = evaluate(d, OFFICIAL_READER);
    expect(sunkenOutlines((e.view ?? e.document)!, deriveEvaluation(e)).map((h) => h.id)).toEqual(['X2']);
  });
});

describe('terrainMesh holes', () => {
  const LOT = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-on-its-lot.json', import.meta.url), 'utf8')) as FloorspecDocument;
  const site = siteDrawing(LOT);
  const origin = [0, 0, 0] as const;
  const hole: [number, number][] = [[0, -40 * FT], [8 * FT, -40 * FT], [8 * FT, -26 * FT], [0, -26 * FT]];
  const whole = terrainMesh(site, { origin })!;
  const holed = terrainMesh(site, { origin, holes: [hole] })!;

  it('drops the cells whose centre is inside a hole, and no other', () => {
    // 8' x 14' of 1' cells: 112 cells, two triangles each
    expect(whole.indices.length - holed.indices.length).toBe(112 * 6);
    // and no triangle left covers a point a foot inside the hole's edge
    const BU = 1_280_000;
    const covers = (px: number, py: number) => {
      for (let t = 0; t < holed.indices.length; t += 3) {
        const p = [0, 1, 2].map((k) => { const v = holed.indices[t + k]!; return [holed.positions[v * 3]! * BU, holed.positions[v * 3 + 1]! * BU] as [number, number]; });
        if (insideRing(px, py, p)) return true;
      }
      return false;
    };
    for (const [x, y] of [[1, -39], [7, -27], [4, -33], [1, -27], [7, -39]] as const) expect(covers(x * FT, y * FT)).toBe(false);
    expect(covers(4 * FT, -42 * FT)).toBe(true);
  });

  it('keeps its contours and its skirt', () => {
    expect(holed.contours.length).toBeGreaterThan(0);
    expect(holed.positions.length).toBe(whole.positions.length);
  });
});
