/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNITS_PER_METRE } from '@floorspec/mesh';
import { GAP, renderPair, sideBySideComposite, swipeComposite } from '../src/pathtrace/pair.js';
import { render3dCompare } from '../src/render3d/index.js';
import { decodeTexture } from '../src/pathtrace/textures.js';
import { pngSize } from '../src/render/png.js';
import { pairParams, render3dParams } from '../src/queue/handlers.js';

/**
 * FLR-T-14.4: matched pairs — A and B through one camera. The composites put A's pixels left of the
 * divider and B's right of it, or both side by side; a pair of the same design is the same picture
 * twice (one camera, one seed), and one of two designs differs where they differ; the rasterized
 * comparison an agent asks for sets them side by side at each side's width; and the job's
 * parameters are read as the api writes them.
 */

type Json = Record<string, unknown>;
const M = UNITS_PER_METRE;
const showcase = (): Json => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

/** The showcase with a saved view looking at its front. */
function withView(): Json {
  const doc = showcase();
  (doc['extensionsUsed'] as Json)['FS_views'] = '0.1.0';
  (doc['extensions'] as Json)['FS_views'] = { views: { SV1: { name: 'Front', eye: [-8 * M, -10 * M, 6 * M], target: [4 * M, 4 * M, 1 * M], focalLength: 24 } } };
  return doc;
}

/** The same house with taller walls: a B that differs where its walls rise higher. */
function taller(doc: Json): Json {
  const b = structuredClone(doc);
  ((b['levels'] as Record<string, Json>)['L1']!)['height'] = 6_000_000;
  return b;
}

/** A flat picture of one colour, 8-bit RGB. */
const flat = (w: number, h: number, rgb: [number, number, number]): Uint8Array => {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) out.set(rgb, 3 * i);
  return out;
};
const at = (rgb: Uint8Array, w: number, x: number, y: number): number[] => [...rgb.subarray(3 * (y * w + x), 3 * (y * w + x) + 3)];

/** A PNG's pixels, as bytes 0–255. */
function pixels(png: Uint8Array): { width: number; height: number; px: (x: number, y: number) => number[] } {
  const t = decodeTexture(png, 'image/png', 'linear')!;
  return { width: t.width, height: t.height, px: (x, y) => [0, 1, 2].map((c) => Math.round(t.data[3 * (y * t.width + x) + c]! * 255)) };
}

describe('a matched pair’s composites', () => {
  it('swipes A’s left part against B’s right part, a light line edged in dark between', () => {
    const a = flat(20, 4, [200, 0, 0]);
    const b = flat(20, 4, [0, 0, 200]);
    const s = swipeComposite(a, b, 20, 4);
    expect(at(s, 20, 0, 0)).toEqual([200, 0, 0]);
    expect(at(s, 20, 7, 3)).toEqual([200, 0, 0]);
    expect(at(s, 20, 12, 0)).toEqual([0, 0, 200]);
    expect(at(s, 20, 19, 3)).toEqual([0, 0, 200]);
    // The divider at the middle (x = 10): light at 9 and 10, dark either side.
    expect(at(s, 20, 9, 1)).toEqual([245, 245, 245]);
    expect(at(s, 20, 10, 1)).toEqual([245, 245, 245]);
    expect(at(s, 20, 8, 1)).toEqual([32, 32, 36]);
    expect(at(s, 20, 11, 1)).toEqual([32, 32, 36]);
    // Anywhere along the width.
    const quarter = swipeComposite(a, b, 20, 4, 0.25);
    expect(at(quarter, 20, 2, 0)).toEqual([200, 0, 0]);
    expect(at(quarter, 20, 8, 0)).toEqual([0, 0, 200]);
    expect(() => swipeComposite(a, flat(10, 4, [0, 0, 0]), 20, 4)).toThrow(/same size/);
  });

  it('sets A and B side by side with a gap', () => {
    const both = sideBySideComposite(flat(10, 3, [200, 0, 0]), flat(10, 3, [0, 0, 200]), 10, 3);
    expect([both.width, both.height]).toEqual([20 + GAP, 3]);
    expect(at(both.rgb, both.width, 9, 2)).toEqual([200, 0, 0]);
    expect(at(both.rgb, both.width, 10, 2)).toEqual([32, 32, 36]);
    expect(at(both.rgb, both.width, 10 + GAP, 2)).toEqual([0, 0, 200]);
  });
});

describe('a matched pair, path-traced', () => {
  it('renders one design twice through one camera as the same picture, with its composites', async () => {
    const doc = withView();
    const seen: number[] = [];
    const r = await renderPair({ document: doc, label: 'Main v1' }, { document: doc, label: 'Main v1 again' }, { view: 'Front', long: 48, samples: 1, onShot: (shot) => { seen.push(shot); } });
    expect([r.width, r.height]).toEqual([48, 32]);
    expect(r.camera).toBe('Front');
    expect([...new Set(seen)]).toEqual([0, 1]);
    expect(Buffer.from(r.a.png).equals(Buffer.from(r.b.png))).toBe(true);
    expect(pngSize(r.swipe)).toEqual({ width: 48, height: 32 });
    expect(pngSize(r.sideBySide)).toEqual({ width: 96 + GAP, height: 32 });
  });

  it('renders two designs from one camera — a shot, or a named view framed on both — differing where they differ', async () => {
    const a = withView();
    const b = taller(a);
    const shot = { name: 'The view in the editor', eye: [-8 * M, -10 * M, 6 * M], target: [4 * M, 4 * M, 1 * M], focalLength: 24 };
    const r = await renderPair({ document: a, label: 'A' }, { document: b, label: 'B' }, { shot, long: 48, samples: 1 });
    expect(r.camera).toBe('The view in the editor');
    expect(Buffer.from(r.a.png).equals(Buffer.from(r.b.png))).toBe(false);
    // The swipe is A's picture on the left, B's on the right.
    const sw = pixels(r.swipe);
    const pa = pixels(r.a.png);
    const pb = pixels(r.b.png);
    for (let y = 0; y < sw.height; y += 4) {
      expect(sw.px(3, y)).toEqual(pa.px(3, y));
      expect(sw.px(44, y)).toEqual(pb.px(44, y));
    }
    const named = await renderPair({ document: a, label: 'A' }, { document: b, label: 'B' }, { camera: 'ne', long: 48, samples: 1 });
    expect(named.camera).toBe('NE iso');
    expect([named.width, named.height]).toEqual([48, 32]);
  });

  it('refuses a view neither side has, a shot that is not a view, and work over the budget', async () => {
    const doc = withView();
    await expect(renderPair({ document: doc, label: 'A' }, { document: doc, label: 'B' }, { view: 'Garden', long: 32, samples: 1 })).rejects.toThrow(/no saved view "Garden"/);
    await expect(renderPair({ document: doc, label: 'A' }, { document: doc, label: 'B' }, { shot: { name: 'x' }, long: 32, samples: 1 })).rejects.toThrow(/FS_views/);
    await expect(renderPair({ document: doc, label: 'A' }, { document: doc, label: 'B' }, { size: 'large', quality: 'high' })).rejects.toThrow(/more work/);
  });
});

describe('a comparison, rasterized', () => {
  it('sets main and the changeset side by side at each side’s width, one camera for both', async () => {
    const a = showcase();
    const same = await render3dCompare({ document: a }, { document: a }, { width: 64 });
    expect(pngSize(same.png)).toEqual({ width: 128 + GAP, height: 48 });
    expect([same.width, same.height]).toEqual([64, 48]);
    const p = pixels(same.png);
    // The same design twice: each pixel of the left half is the right half's.
    for (let y = 0; y < 48; y += 6) for (let x = 0; x < 64; x += 7) expect(p.px(x, y)).toEqual(p.px(x + 64 + GAP, y));
    const changed = await render3dCompare({ document: a }, { document: taller(a) }, { width: 64, camera: 'ne' });
    expect(changed.camera).toBe('NE iso');
    const q = pixels(changed.png);
    let differs = 0;
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) if (q.px(x, y).join() !== q.px(x + 64 + GAP, y).join()) differs++;
    expect(differs).toBeGreaterThan(0);
    await expect(render3dCompare({ document: a }, { document: a }, { width: 64, room: 'Attic' })).rejects.toThrow(/no room Attic/);
  });
});

describe('a pair’s and a comparison’s job parameters', () => {
  const B = 'b'.repeat(64);
  it('reads a pair as the api writes it', () => {
    expect(pairParams({ aLabel: 'Main v4', pair: { hash: B, seq: null, label: 'Changeset · Bigger island', design: { KS: 'KB' } }, shot: { name: 'x' }, size: 'small', quality: 'draft', design: { KS: 'KA' } })).toEqual({
      design: { KS: 'KA' },
      aLabel: 'Main v4',
      b: { hash: B, label: 'Changeset · Bigger island', design: { KS: 'KB' } },
      shot: { name: 'x' },
      size: 'small',
      quality: 'draft',
    });
    expect(pairParams({ pair: { hash: B }, camera: 'se', view: 'SV1' })).toMatchObject({ aLabel: 'A', b: { label: 'B' }, camera: 'se', view: 'SV1', size: 'small', quality: 'draft' });
    expect(() => pairParams({ pair: { hash: 'nope' } })).toThrow(/names its B/);
    expect(() => pairParams({ pair: { hash: B }, size: 'large', quality: 'high' })).toThrow(/more work/);
  });

  it('reads a comparison’s main from a 3D render’s parameters', () => {
    expect(render3dParams({ compare: { hash: B, design: { KS: 'KB' } }, camera: 'sw' })).toEqual({ compare: { hash: B, design: { KS: 'KB' } }, camera: 'sw' });
    expect(render3dParams({ compare: { hash: 'short' } })).toEqual({});
  });
});
