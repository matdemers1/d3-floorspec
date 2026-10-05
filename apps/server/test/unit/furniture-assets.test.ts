import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeSvg, SvgError, looksLikeSvg } from '../../src/assets/svg.js';
import { ModelError, prepareModel } from '../../src/assets/gltf.js';
import { prepareUpload, purposeOf } from '../../src/assets/upload.js';
import { MediaError } from '../../src/assets/media.js';
import { packagePath } from '../../src/routes/assets.js';
import { tilePng } from '../support/images.js';

/**
 * FLR-T-8.3: what a model and a plan symbol upload are, read from their bytes — a glTF 2.0 model,
 * self-contained; an SVG kept only as an allowlist of drawing, or a PNG.
 */

const LIBRARY = new URL('../../../../packages/engine/standard/registry/FS_furniture/library/', import.meta.url);
const libraryFile = (path: string) => new Uint8Array(readFileSync(new URL(path, LIBRARY)));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A GLB around a JSON chunk (and an optional binary chunk), padded as glTF says. */
export function glb(json: object, bin?: Uint8Array): Uint8Array {
  const pad = (b: Uint8Array, fill: number) => {
    const out = new Uint8Array(Math.ceil(b.length / 4) * 4).fill(fill);
    out.set(b);
    return out;
  };
  const j = pad(enc(JSON.stringify(json)), 0x20);
  const b = bin === undefined ? undefined : pad(bin, 0);
  const length = 12 + 8 + j.length + (b === undefined ? 0 : 8 + b.length);
  const out = new Uint8Array(length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, length, true);
  v.setUint32(12, j.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  if (b !== undefined) {
    v.setUint32(20 + j.length, b.length, true);
    v.setUint32(24 + j.length, 0x004e4942, true);
    out.set(b, 28 + j.length);
  }
  return out;
}

describe('a model upload (glTF 2.0)', () => {
  it('takes every library model as it is, as a binary glTF', () => {
    for (const item of ['refrigerator-900', 'sofa-2100', 'wall-cabinet-600']) {
      const bytes = libraryFile(`models/${item}.glb`);
      const m = prepareModel(bytes);
      expect(m.mediaType).toBe('model/gltf-binary');
      expect(m.bytes).toBe(bytes);
    }
  });

  it('takes a .gltf whose buffers are embedded', () => {
    const json = { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }] };
    expect(prepareModel(enc(JSON.stringify(json))).mediaType).toBe('model/gltf+json');
  });

  it('refuses a model that names another file, and says to export a .glb', () => {
    const json = { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'chair.bin' }] };
    expect(() => prepareModel(enc(JSON.stringify(json)))).toThrow(/chair\.bin.*\.glb/);
    expect(() => prepareModel(glb({ asset: { version: '2.0' }, images: [{ uri: 'https://example.test/wood.png' }] }))).toThrow(ModelError);
  });

  it('refuses glTF 1, a required extension, and a damaged GLB', () => {
    expect(() => prepareModel(glb({ asset: { version: '1.0' } }))).toThrow(/2\.0/);
    expect(() => prepareModel(glb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }))).toThrow(/KHR_draco/);
    const cut = glb({ asset: { version: '2.0' } }).subarray(0, 24);
    expect(() => prepareModel(cut)).toThrow(/cut short/);
  });

  it('refuses what is not a model, as 415', () => {
    try {
      prepareModel(tilePng(4, 4));
      expect.unreachable();
    } catch (e) {
      expect((e as ModelError).status).toBe(415);
    }
  });
});

describe('an SVG plan symbol', () => {
  it('keeps a clean library symbol byte for byte, so its digest is the catalogue’s', () => {
    const bytes = libraryFile('symbols/refrigerator-900.svg');
    const s = sanitizeSvg(bytes);
    expect(s.removed).toEqual([]);
    expect(s.bytes).toBe(bytes);
    expect([s.width, s.height]).toEqual([900, 700]);
  });

  it('removes script, handlers, foreignObject, style sheets and outside references, and keeps the drawing', () => {
    const evil = `<?xml version="1.0"?>
<!-- made in a tool -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50" onload="alert(1)">
  <script>alert(document.cookie)</script>
  <style>rect { fill: url(https://evil.test/x.png) }</style>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
  <a href="javascript:alert(1)"><rect x="0" y="0" width="1" height="1"/></a>
  <image href="https://evil.test/track.png" width="1" height="1"/>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>
  <rect x="1" y="2" width="98" height="46" fill="url(#g)" stroke="url(https://evil.test/p)" style="stroke-width:2;background:url(https://evil.test/b)" onclick="steal()"/>
  <use xlink:href="#g"/>
  <use href="https://evil.test/sprite.svg#a"/>
  <text x="5" y="20">Fridge &amp; freezer</text>
</svg>`;
    const s = sanitizeSvg(enc(evil));
    const out = dec(s.bytes);
    for (const bad of ['script', 'alert', 'onload', 'onclick', 'foreignObject', 'evil.test', '<style', 'javascript', '<a ', '<image']) expect(out).not.toContain(bad);
    expect(out).toContain('<rect x="1" y="2" width="98" height="46" fill="url(#g)"/>');
    expect(out).toContain('<use xlink:href="#g"/>');
    expect(out).toContain('<text x="5" y="20">Fridge &amp; freezer</text>');
    expect(out).toContain('<linearGradient id="g">');
    expect(s.removed).toEqual(expect.arrayContaining(['<script>', '<style>', '<foreignObject>', '<a>', '<image>', '@onload', '@onclick', '@stroke', '@style', 'comment']));
    // What came out reads again, with nothing more to remove.
    expect(sanitizeSvg(s.bytes).removed).toEqual([]);
  });

  it('refuses a DOCTYPE — entities can expand or fetch — and an undefined entity', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg">&b;</svg>';
    expect(() => sanitizeSvg(enc(bomb))).toThrow(/DOCTYPE/);
    expect(() => sanitizeSvg(enc('<svg xmlns="http://www.w3.org/2000/svg"><title>&xxe;</title></svg>'))).toThrow(SvgError);
  });

  it('refuses what is not well-formed or not an SVG', () => {
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', '<html></html>', '<svg width=10></svg>', '<svg/><svg/>', 'hello <svg/>']) expect(() => sanitizeSvg(enc(bad)), bad).toThrow(SvgError);
    expect(() => sanitizeSvg(new Uint8Array([0x3c, 0xff, 0xfe]))).toThrow(/UTF-8/);
  });

  it('adds the SVG namespace a root without one needs to draw as an image', () => {
    const s = sanitizeSvg(enc('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'));
    expect(dec(s.bytes)).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">');
  });

  it('is recognised from its first element, after a declaration and comments', () => {
    expect(looksLikeSvg(enc('\uFEFF<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
    expect(looksLikeSvg(enc('<html><svg/></html>'))).toBe(false);
  });
});

describe('what each purpose accepts', () => {
  it('keeps a texture upload images-only, as it was', () => {
    expect(() => prepareUpload(libraryFile('models/sofa-2100.glb'), 'texture')).toThrow(MediaError);
    expect(() => prepareUpload(libraryFile('symbols/sofa-2100.svg'), 'texture')).toThrow(MediaError);
    expect(purposeOf(undefined)).toBe('texture');
    expect(purposeOf('model')).toBe('model');
    expect(purposeOf('script')).toBeNull();
  });

  it('takes a model as a model and a symbol as an SVG or a PNG', () => {
    expect(prepareUpload(libraryFile('models/sofa-2100.glb'), 'model')).toMatchObject({ mediaType: 'model/gltf-binary', width: 0, height: 0 });
    expect(prepareUpload(libraryFile('symbols/sofa-2100.svg'), 'symbol')).toMatchObject({ mediaType: 'image/svg+xml', width: 2100, height: 900 });
    expect(prepareUpload(tilePng(8, 8), 'symbol')).toMatchObject({ mediaType: 'image/png', width: 8 });
    expect(() => prepareUpload(libraryFile('models/sofa-2100.glb'), 'symbol')).toThrow(/SVG or a PNG/);
    expect(() => prepareUpload(libraryFile('symbols/sofa-2100.svg'), 'model')).toThrow(/glTF/);
  });

  it('puts a model and a symbol at assets/<sha256>.glb, .gltf and .svg in the package', () => {
    const d = 'a'.repeat(64);
    expect(packagePath(d, 'model/gltf-binary')).toBe(`assets/${d}.glb`);
    expect(packagePath(d, 'model/gltf+json')).toBe(`assets/${d}.gltf`);
    expect(packagePath(d, 'image/svg+xml')).toBe(`assets/${d}.svg`);
  });
});
