/**
 * A material's base-colour map, decoded for the path tracer. PNG and JPEG — the two kinds the asset
 * store keeps (Core 18.2) — are decoded by resvg, which the worker already carries for the plan
 * render: the image is wrapped in an SVG its own size and rendered once. No new decoder, and no
 * image is trusted further than its signature and its declared size.
 */
import { Resvg } from '@resvg/resvg-js';

export interface Texture {
  readonly width: number;
  readonly height: number;
  /** Linear RGB, three floats a texel, rows top to bottom (v = 0 at the top, as glTF). */
  readonly data: Float32Array;
}

/** A map larger than this on either side is left out: a still is no place for an 8K texture. */
export const MAX_TEXTURE_SIDE = 4096;

/** The width and height a PNG's IHDR or a JPEG's start-of-frame declares. */
export function imageSize(bytes: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mediaType === 'image/png') {
    if (bytes.byteLength < 24 || v.getUint32(0) !== 0x89504e47 || v.getUint32(12) !== 0x49484452) return undefined;
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (mediaType === 'image/jpeg') {
    let at = 2;
    while (at + 9 < bytes.byteLength) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      const len = v.getUint16(at + 2);
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: v.getUint16(at + 7), height: v.getUint16(at + 5) };
      at += 2 + len;
    }
  }
  return undefined;
}

const channel = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const SRGB = Float32Array.from({ length: 256 }, (_, i) => channel(i / 255));
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => i / 255);

/**
 * Decode a PNG or JPEG into linear RGB; undefined when it is not one, or too big. A base colour map
 * is sRGB and is made linear; a data map — a normal map, a metallic-roughness or occlusion map
 * (Core 18.2: linear) — is read as it is, each channel 0–1.
 */
export function decodeTexture(bytes: Uint8Array, mediaType: string, encoding: 'srgb' | 'linear' = 'srgb'): Texture | undefined {
  const size = imageSize(bytes, mediaType);
  if (size === undefined || size.width < 1 || size.height < 1 || size.width > MAX_TEXTURE_SIDE || size.height > MAX_TEXTURE_SIDE) return undefined;
  const { width, height } = size;
  const href = `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><image width="${String(width)}" height="${String(height)}" preserveAspectRatio="none" xlink:href="${href}"/></svg>`;
  let pixels: Uint8Array;
  try {
    const out = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false }, logLevel: 'off' }).render();
    if (out.width !== width || out.height !== height) return undefined;
    pixels = new Uint8Array(out.pixels);
  } catch {
    return undefined;
  }
  // Shared memory: the tracer's threads read the same texels rather than a copy each.
  const data = new Float32Array(new SharedArrayBuffer(width * height * 3 * 4));
  const curve = encoding === 'srgb' ? SRGB : LINEAR;
  for (let i = 0; i < width * height; i++) {
    data[3 * i] = curve[pixels[4 * i]!]!;
    data[3 * i + 1] = curve[pixels[4 * i + 1]!]!;
    data[3 * i + 2] = curve[pixels[4 * i + 2]!]!;
  }
  return { width, height, data };
}

/** Bilinear, wrapping: a map tiles (Core 18.3). Writes linear RGB into `out`. */
export function sample(t: Texture, u: number, v: number, out: Float64Array): void {
  const x = (u - Math.floor(u)) * t.width - 0.5;
  const y = (v - Math.floor(v)) * t.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const W = t.width;
  const H = t.height;
  const xa = ((x0 % W) + W) % W;
  const xb = (xa + 1) % W;
  const ya = ((y0 % H) + H) % H;
  const yb = (ya + 1) % H;
  const d = t.data;
  for (let c = 0; c < 3; c++) {
    const a = d[3 * (ya * W + xa) + c]! * (1 - fx) + d[3 * (ya * W + xb) + c]! * fx;
    const b = d[3 * (yb * W + xa) + c]! * (1 - fx) + d[3 * (yb * W + xb) + c]! * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

/**
 * A map's mip chain (FLR-T-13.6): the map, then each level a 2 × 2 box average of the one before,
 * down to a texel — so a rasterizer that draws a brick wall far off draws its mean colour, not a
 * shimmer of mortar and brick.
 */
export function mipChain(t: Texture): Texture[] {
  const chain: Texture[] = [t];
  let c = t;
  while (c.width > 1 || c.height > 1) {
    const w = Math.max(1, c.width >> 1);
    const h = Math.max(1, c.height >> 1);
    const data = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          let n = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(c.width - 1, 2 * x + dx);
              const sy = Math.min(c.height - 1, 2 * y + dy);
              sum += c.data[3 * (sy * c.width + sx) + k]!;
              n++;
            }
          data[3 * (y * w + x) + k] = sum / n;
        }
    c = { width: w, height: h, data };
    chain.push(c);
  }
  return chain;
}

/** Sample a mip chain at a level of detail (0 the map itself; each 1 a level smaller), trilinearly. */
export function sampleLod(chain: readonly Texture[], u: number, v: number, lod: number, out: Float64Array): void {
  const l = Math.max(0, Math.min(chain.length - 1, lod));
  const l0 = Math.floor(l);
  const f = l - l0;
  sample(chain[l0]!, u, v, out);
  if (f <= 0 || l0 + 1 >= chain.length) return;
  const r = out[0]!;
  const g = out[1]!;
  const b = out[2]!;
  sample(chain[l0 + 1]!, u, v, out);
  out[0] = r + (out[0]! - r) * f;
  out[1] = g + (out[1]! - g) * f;
  out[2] = b + (out[2]! - b) * f;
}
