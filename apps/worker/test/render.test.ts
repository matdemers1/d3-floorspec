/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { renderPlan } from '@floorspec/render2d';
import { describe, expect, it } from 'vitest';
import { planFontFiles, pngSize, rasterize, renderPlanPng, woffToSfnt } from '../src/render/index.js';

const require = createRequire(import.meta.url);
const fixture = (name: string): object =>
  JSON.parse(readFileSync(new URL(`../../../packages/mcp/test/fixtures/${name}.json`, import.meta.url), 'utf8')) as object;
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const fontDir = mkdtempSync(join(tmpdir(), 'floorspec-fonts-test-'));

/** Decoded RGBA pixels of an SVG, through the same fonts the worker uses. */
function pixels(svg: string, width: number): { data: Uint8Array; width: number; height: number } {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false, fontFiles: planFontFiles(fontDir), defaultFontFamily: 'Inter', monospaceFamily: 'JetBrains Mono' },
  }).render();
  return { data: new Uint8Array(r.pixels), width: r.width, height: r.height };
}

describe('WOFF unwrapping', () => {
  it('turns a WOFF 1.0 font into the TrueType font it carries, every table intact', () => {
    const woff = readFileSync(require.resolve('@fontsource/inter/files/inter-latin-500-normal.woff'));
    const ttf = woffToSfnt(woff);
    const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
    const w = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    expect(v.getUint32(0)).toBe(w.getUint32(4)); // the flavor: 0x00010000 (TrueType) or 'OTTO'
    expect(v.getUint16(4)).toBe(w.getUint16(12));
    expect(ttf.byteLength).toBeGreaterThanOrEqual(w.getUint32(16)); // totalSfntSize, before padding
    expect(sha(woffToSfnt(woff))).toBe(sha(ttf));
  });

  it('refuses what is not WOFF 1.0', () => {
    expect(() => woffToSfnt(new Uint8Array(64))).toThrow(/not a WOFF/);
  });

  it('gives resvg fonts it can draw text with', () => {
    const svg = (text: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="200" height="40" fill="#fff"/><text x="4" y="28" font-family="Inter" font-size="20">${text}</text></svg>`;
    const blank = pixels(svg(''), 200).data;
    const text = pixels(svg(`Kitchen 12' 6"`), 200).data;
    let differing = 0;
    for (let i = 0; i < blank.length; i += 4) if (blank[i] !== text[i]) differing++;
    expect(differing).toBeGreaterThan(200);
  });
});

describe('renderPlanPng', () => {
  const doc = fixture('three-room-house');

  it('rasterises at the requested width, keeping the plan’s aspect', () => {
    const svg = renderPlan(doc);
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg)!.map(Number) as [number, number, number];
    const png = renderPlanPng(doc, { width: 800, fontDir });
    const size = pngSize(png);
    expect(size.width).toBe(800);
    expect(Math.abs(size.height - (h * 800) / w)).toBeLessThanOrEqual(1);
    expect(pngSize(renderPlanPng(doc, { fontDir }))).toEqual({ width: w, height: h });
  });

  it('is deterministic: the same document gives the same bytes, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const a = renderPlanPng(doc, { theme, width: 640, fontDir });
      const b = renderPlanPng(structuredClone(doc), { theme, width: 640, fontDir });
      expect(sha(a)).toBe(sha(b));
    }
    expect(sha(renderPlanPng(doc, { theme: 'light', width: 640, fontDir }))).not.toBe(sha(renderPlanPng(doc, { theme: 'dark', width: 640, fontDir })));
  });

  it('draws a plan, not an empty canvas: poché, floors and paper in sane proportions, and text', () => {
    const { data } = pixels(renderPlan(doc, { theme: 'light' }), 800);
    let ink = 0;
    let white = 0;
    let paper = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
      if (r < 40 && g < 40 && b < 40) ink++;
      else if (r === 255 && g === 255 && b === 255) white++;
      else if (r === 0xf0 && g === 0xf2 && b === 0xf7) paper++;
    }
    // Walls are a thin band around and through the rooms; rooms most of the drawing.
    expect(ink / n).toBeGreaterThan(0.04);
    expect(ink / n).toBeLessThan(0.25);
    expect(white / n).toBeGreaterThan(0.35);
    expect(paper / n).toBeGreaterThan(0.1);

    // Labels draw: the same plan with and without them differs inside the rooms.
    const bare = pixels(renderPlan(doc, { theme: 'light', labels: false }), 800).data;
    let differing = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] !== bare[i]) differing++;
    expect(differing).toBeGreaterThan(500);
  });

  it('rejects a width it cannot honour', () => {
    expect(() => rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', { width: 0 })).toThrow(RangeError);
    expect(() => rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', { width: 1.5 })).toThrow(RangeError);
  });

  it('caches the fonts once per directory', () => {
    expect(planFontFiles(fontDir)).toBe(planFontFiles(fontDir));
    expect(planFontFiles(fontDir)).toHaveLength(5);
  });
});
