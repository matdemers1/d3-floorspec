/**
 * The heat-loss map in 3D (FLR-T-16.4): the Courtyard House's envelope as one untextured mesh, every
 * vertex carrying its surface's band — its fibre-cement walls on both faces, a window over its wall, its
 * shed roofs' faces — the same bytes every time; and ear-clipping checked against a polygon's area.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEvaluation, evaluate, OFFICIAL_READER } from '@floorspec/engine';
import { earClip, heatLossMesh, LOSS_BANDS, type HeatLossSurface } from '../src/index.js';

const input = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-envelope.json', import.meta.url), 'utf8')) as object;
const ev = evaluate(input, OFFICIAL_READER);
const derived = deriveEvaluation(ev);
const doc = (ev.view ?? ev.document)!;
const fc = Object.entries(doc.walls ?? {}).filter(([, w]) => w!.type === 'wall-2x6-exterior-fibre-cement').map(([id]) => id).sort();
const window = Object.entries(doc.openings ?? {}).find(([, o]) => o!.fill === 'window-fixed-72x48')![0];
const surfaces: HeatLossSurface[] = [
  ...fc.map((element) => ({ element, kind: 'wall' as const, band: 'typical' as const })),
  { element: window, kind: 'window', band: 'high' },
  { element: 'RF1', kind: 'roof', band: 'low' },
  { element: 'RF2', kind: 'roof', band: 'low' },
];

/** A triangle's area in plan. */
const planArea = (p: Float32Array, i: number): number => Math.abs((p[i + 3]! - p[i]!) * (p[i + 7]! - p[i + 1]!) - (p[i + 4]! - p[i + 1]!) * (p[i + 6]! - p[i]!)) / 2;

const triArea = (p: Float32Array, i: number): number => {
  const a = [p[i]!, p[i + 1]!, p[i + 2]!], b = [p[i + 3]!, p[i + 4]!, p[i + 5]!], c = [p[i + 6]!, p[i + 7]!, p[i + 8]!];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
};

describe('the heat-loss map', () => {
  const m = heatLossMesh(doc, derived, surfaces);

  it('draws every surface, its band on every vertex, its element on every triangle', () => {
    const tris = m.positions.length / 9;
    expect(tris).toBeGreaterThan(fc.length * 4);
    expect(m.bands.length).toBe(tris * 3);
    expect(m.elements.length).toBe(tris);
    expect(new Set(m.elements)).toEqual(new Set([...fc, window, 'RF1', 'RF2']));
    for (let t = 0; t < tris; t++) {
      const want = LOSS_BANDS.indexOf(surfaces.find((s) => s.element === m.elements[t])!.band);
      expect([m.bands[t * 3], m.bands[t * 3 + 1], m.bands[t * 3 + 2]]).toEqual([want, want, want]);
    }
  });

  it('a wall is coloured on both faces, its full height', () => {
    const id = fc[0]!;
    const d = derived.walls[id]!;
    let area = 0;
    for (let t = 0; t < m.elements.length; t++) if (m.elements[t] === id) area += triArea(m.positions, t * 9);
    const length = Math.hypot(d.endLeft[0] - d.startLeft[0], d.endLeft[1] - d.startLeft[1]) + Math.hypot(d.endRight[0] - d.startRight[0], d.endRight[1] - d.startRight[1]);
    const height = d.topElevation - d.baseElevation;
    expect(area).toBeCloseTo((length * height) / 1_280_000 ** 2, 1);
  });

  it('a roof covers its faces (Core 16’s face areas are in plan), ear-clipped exactly', () => {
    const r = derived.roofs!['RF1']!;
    let area = 0;
    for (let t = 0; t < m.elements.length; t++) if (m.elements[t] === 'RF1') area += planArea(m.positions, t * 9);
    const faces = r.surface!.faces.reduce((s, f) => s + Number(f.area), 0) / 1_280_000 ** 2;
    expect(area).toBeCloseTo(faces, 2);
  });

  it('uses no texture: positions, normals and bands only', () => {
    expect(Object.keys(m).sort()).toEqual(['bands', 'elements', 'levels', 'normals', 'positions']);
    expect(m.normals.length).toBe(m.positions.length);
  });

  it('is the same bytes every time', () => {
    const again = heatLossMesh(doc, derived, [...surfaces].reverse());
    expect(Buffer.from(again.positions.buffer).equals(Buffer.from(m.positions.buffer))).toBe(true);
    expect(again.elements).toEqual(m.elements);
  });
});

describe('ear-clipping', () => {
  it('an L of six corners is four triangles covering its area, either way round', () => {
    const L: [number, number][] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];
    for (const poly of [L, [...L].reverse()]) {
      const t = earClip(poly);
      expect(t).toHaveLength(4);
      const area = t.reduce((s, [a, b, c]) => {
        const [p, q, r] = [poly[a]!, poly[b]!, poly[c]!];
        return s + Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
      }, 0);
      expect(area).toBe(6);
    }
  });
});
