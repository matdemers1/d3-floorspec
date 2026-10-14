import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  annoSourceOf,
  approxMeasure,
  buildScene,
  customString,
  exteriorStrings,
  layoutAnnotations,
  MIN_SPAN,
  openingMarks,
  PDF_METRICS,
  roomStrings,
  scaleBarOf,
  tagsOf,
  type AnnoPrim,
  type DimString,
} from '../src/index.js';

/**
 * FLR-T-18.11: the one dimensioning layout. The Courtyard House — an arc bay on its west, a courtyard
 * in its middle, walls of two thicknesses — is where FLR-T-18.5 found the old exterior chain printing
 * inch-long spans along the top and a stack of strings down the left.
 */

const HOUSE = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const scene = buildScene(HOUSE, 'L1');
const src = annoSourceOf(scene);
const extent = (() => {
  let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const w of scene.walls.values()) for (const [x, y] of w.outline) b = { minX: Math.min(b.minX, x), minY: Math.min(b.minY, y), maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y) };
  return b;
})();
const strings = exteriorStrings(src, extent);
const k = 72 / (32_512 * 128); // 3/32" = 1'-0", points per base unit
const frame = { P: (p: readonly [number, number]): [number, number] => [p[0] * k, -p[1] * k], k };
const fmt = (v: number): string => `${String(Math.round(v / 32_512))}"`;

describe('exterior strings (FLR-T-18.11)', () => {
  it('measure every side, nearest first: openings located, jogs, overall — and no span under 6"', () => {
    for (const side of ['N', 'S', 'E', 'W'] as const) {
      const mine = strings.filter((s) => s.side === side && s.local !== true);
      expect(mine.at(-1)?.kind, side).toBe('overall');
      expect(mine.map((s) => s.tier)).toEqual(mine.map((_, i) => i));
    }
    for (const s of strings) for (const l of s.lengths) expect(l, s.id).toBeGreaterThanOrEqual(MIN_SPAN);
  });

  it('measures the arc bay to its ends and its furthest point, not its facets', () => {
    const west = strings.find((s) => s.side === 'W' && s.kind === 'jogs')!;
    // The bay's west face is an arc of many facets: the west strings stop at a handful of points.
    expect(west.stops.length).toBeLessThan(8);
    const overall = strings.find((s) => s.side === 'N' && s.kind === 'overall')!;
    expect(overall.stops[0]!.along).toBe(extent.minX);
    expect(overall.lengths[0]).toBe(extent.maxX - extent.minX);
  });

  it('locates a recessed face’s openings on a string of its own, just off that face', () => {
    const local = strings.filter((s) => s.local === true);
    expect(local.length).toBeGreaterThan(0);
    for (const s of local) expect(s.kind).toBe('openings');
  });

  it('adds up: each string’s spans are its ends’ distance, exactly', () => {
    for (const s of strings) expect(s.lengths.reduce((a, b) => a + b, 0)).toBe(s.stops.at(-1)!.along - s.stops[0]!.along);
  });
});

describe('the layout on paper', () => {
  const { prims, depth } = layoutAnnotations({ strings }, frame, PDF_METRICS, approxMeasure, fmt);
  const texts = prims.filter((p): p is Extract<AnnoPrim, { t: 'text' }> => p.t === 'text');

  it('stacks each side’s strings outward without two lengths overlapping', () => {
    const boxes = texts.map((t) => {
      const w = approxMeasure(t.text, 'mono', t.size);
      const h = t.size * 0.72;
      return t.rotate === 0 ? { x0: t.x - w / 2, x1: t.x + w / 2, y0: t.y - h, y1: t.y } : { x0: t.x - h, x1: t.x, y0: t.y - w / 2, y1: t.y + w / 2 };
    });
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.2 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.2;
        expect(overlap, `${texts[i]!.text} / ${texts[j]!.text}`).toBe(false);
      }
  });

  it('reports how deep each side’s strings reach, for the sheet’s margins', () => {
    for (const side of ['N', 'S', 'E', 'W'] as const) expect(depth[side]).toBeGreaterThan(PDF_METRICS.first);
  });

  it('reads vertical strings bottom to top', () => {
    expect(texts.some((t) => t.rotate === -90)).toBe(true);
    expect(texts.every((t) => t.rotate === 0 || t.rotate === -90)).toBe(true);
  });
});

describe('rooms, tags, the person’s own strings, the scale bar', () => {
  it('runs a string across and up each room big enough, wall face to wall face, clear of its label', () => {
    const rooms = roomStrings(src, k, () => ({ halfW: 20, halfH: 8 }), 10);
    const den = rooms.filter((s) => s.id.startsWith('room:R6:'));
    expect(den.map((s) => s.id).sort()).toEqual(['room:R6:h', 'room:R6:v']);
    // The powder room is too small to dimension at all.
    expect(rooms.some((s) => s.id.startsWith('room:R4:'))).toBe(false);
  });

  it('numbers doors and windows in reading order and tags each off its face', () => {
    const marks = openingMarks([{ openings: [...scene.openings.values()] }]);
    const tags = tagsOf(src, marks);
    expect(tags.filter((t) => t.kind === 'door').length).toBeGreaterThan(0);
    expect(new Set(tags.map((t) => t.mark)).size).toBe(tags.length);
    for (const t of tags) expect(Math.hypot(t.normal[0], t.normal[1])).toBeCloseTo(1, 6);
  });

  it('draws a person’s string along its own direction, reading upward', () => {
    const s = customString({ id: 'DM1', direction: [0, -1], anchors: [{ feature: [0, 100], onLine: [10, 100] }, { feature: [0, 0], onLine: [10, 0] }], lengths: [100] }) as DimString;
    expect(s.u).toEqual([0, 1]);
    expect(s.stops.map((x) => x.along)).toEqual([-100, 0]);
    expect(s.lengths).toEqual([100]);
  });

  it('picks a scale bar of round feet at least as long as asked', () => {
    const bar = scaleBarOf(k, false, 72);
    expect(bar.width).toBeGreaterThanOrEqual(72);
    expect(bar.labels.at(-1)).toMatch(/^\d+'$/);
  });
});
