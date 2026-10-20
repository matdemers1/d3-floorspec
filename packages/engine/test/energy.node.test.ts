/**
 * FS_energy 0.1.0 (FLR-T-16.1): the engine's drawing of solar — each roof face with its tilt, bearing and
 * edges classed eave, ridge or rake, an array's modules on its face or rack — agrees with what FS_energy
 * derives exactly: a flush array's modules lie inside its footprint, on its face's plane; the length up a slope
 * is projected once; a corner exactly at a setback is clear and one base unit inside it is not; and the same
 * document always draws the same.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrayFootprint, arrayModules, check, cornerClear, deriveRoofs, facePolygons, OFFICIAL_READER, roofFaces, setbackBands, setbacksOf, slopeToPlan, solarDrawing, type FloorspecDocument, type SolarArray } from '../src/index.js';

const ext = join(import.meta.dirname, '..', 'standard', 'conformance', 'ext');
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const sunny = (): FloorspecDocument => structuredClone(read(join(ext, 'FS_energy', '0.1.0', 'examples', '001-p16-sunny-house', 'input.json'))) as FloorspecDocument;
const courtyard = (): FloorspecDocument => JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'apps', 'worker', 'test', 'fixtures', 'courtyard-house-solar.json'), 'utf8')) as FloorspecDocument;
const FT = 390_144;
type Json = Record<string, unknown>;
const pv = (d: FloorspecDocument, id: string): SolarArray => ((d.extensions as Json)['FS_energy'] as { collections: { pvArrays: Record<string, SolarArray> } }).collections.pvArrays[id]!;

describe('roof faces', () => {
  it('derives the sunny house’s faces: a gable’s south and north faces at 9:12 and the carport’s flat roof', () => {
    const faces = roofFaces(sunny());
    expect(faces.map((f) => [f.key, Math.round(f.tilt * 10) / 10, f.bearing === null ? null : Math.round(f.bearing)])).toEqual([
      ['RF1:0', 36.9, 180],
      ['RF1:2', 36.9, 0],
      ['RF2', 0, null],
    ]);
    const south = faces[0]!;
    // the south face: its eave along y = -4', its ridge at y = 6', rakes at its ends
    expect(south.edges.map((e) => e.kind).sort()).toEqual(['eave', 'rake', 'rake', 'ridge']);
    expect(faces[2]!.edges.every((e) => e.kind === 'eave')).toBe(true);
    // a strip for every edge that keeps a setback, inward
    expect(setbackBands(south)).toHaveLength(4);
  });

  it('derives the Courtyard House’s: the east wing’s shed facing east, the guest wing’s facing north, the garage flat', () => {
    const faces = roofFaces(courtyard());
    expect(faces.map((f) => [f.key, f.bearing === null ? null : Math.round(f.bearing), Math.round(f.tilt * 10) / 10])).toEqual([
      ['RF1:1', 90, 9.5],
      ['RF2:2', 0, 14],
      ['RF3', null, 0],
    ]);
  });
});

describe('arrays', () => {
  it('projects a length up the slope once: 5′ at 9:12 is exactly 4′ in plan', () => {
    expect(slopeToPlan(5n * BigInt(FT), { rise: 9, run: 12 })).toBe(4n * BigInt(FT));
    expect(slopeToPlan(1n, { rise: 4, run: 3 })).toBe(1n); // 0.6
  });

  it('lays a flush array’s modules inside its exact footprint, on its face’s plane plus the standoff', () => {
    const d = sunny();
    const roofs = deriveRoofs(d, true);
    const a = pv(d, 'PV1');
    const mods = arrayModules(d, a, roofs['RF1']);
    expect(mods).toHaveLength(5);
    const fp = arrayFootprint(d, a).map((p) => [Number(p[0]), Number(p[1])]);
    const xs = fp.map((p) => p[0]!);
    const ys = fp.map((p) => p[1]!);
    for (const m of mods)
      for (const c of m.corners) {
        expect(c[0]).toBeGreaterThanOrEqual(Math.min(...xs) - 1);
        expect(c[0]).toBeLessThanOrEqual(Math.max(...xs) + 1);
        expect(c[1]).toBeGreaterThanOrEqual(Math.min(...ys) - 1);
        expect(c[1]).toBeLessThanOrEqual(Math.max(...ys) + 1);
      }
    // 9:12 faces south: up the slope, z rises 3/4 of the run; the module's normal leans south
    const m = mods[0]!;
    expect(m.normal[1]).toBeLessThan(0);
    expect(m.normal[2]).toBeCloseTo(0.8, 6);
  });

  it('racks the carport’s modules: each rack’s back edge higher than its front', () => {
    const d = sunny();
    const mods = arrayModules(d, pv(d, 'PV2'), deriveRoofs(d, true)['RF2']);
    expect(mods).toHaveLength(6);
    for (const m of mods) expect(Math.max(...m.corners.map((c) => c[2])) - Math.min(...m.corners.map((c) => c[2]))).toBeGreaterThan(0.2 * FT);
  });

  it('tests a corner exactly against a setback: at it, clear; one base unit inside it, not', () => {
    const d = sunny();
    const roofs = deriveRoofs(d, true);
    const polys = facePolygons(roofs['RF1']!, { face: 0 });
    const s = setbacksOf(d);
    const eave = roofs['RF1']!.eave;
    // the eave runs along y = -4'; its setback is 18"
    expect(cornerClear([4n * BigInt(FT), BigInt(-4 * FT + 18 * 32_512)], polys, eave, s)).toBe(true);
    expect(cornerClear([4n * BigInt(FT), BigInt(-4 * FT + 18 * 32_512 - 1)], polys, eave, s)).toBe(false);
  });

  it('draws what the conformance suite derives, and the same every time', () => {
    const d = courtyard();
    const r = check(d, OFFICIAL_READER);
    expect(r.valid).toBe(true);
    const drawing = solarDrawing(d);
    const derived = (r.derived!.extensions as { FS_energy: { arrays: Record<string, { footprint: [number, number][]; watts: number }> } }).FS_energy;
    for (const a of drawing.arrays) {
      expect(a.footprint).toEqual(derived.arrays[a.id]!.footprint);
      expect(a.watts).toBe(derived.arrays[a.id]!.watts);
      expect(a.clear).toBe(true);
    }
    expect(JSON.stringify(solarDrawing(courtyard()))).toBe(JSON.stringify(drawing));
  });
});
