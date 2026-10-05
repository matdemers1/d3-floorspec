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

/** Decode a PNG or JPEG into linear RGB; undefined when it is not one, or too big. */
export function decodeTexture(bytes: Uint8Array, mediaType: string): Texture | undefined {
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
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[3 * i] = SRGB[pixels[4 * i]!]!;
    data[3 * i + 1] = SRGB[pixels[4 * i + 1]!]!;
    data[3 * i + 2] = SRGB[pixels[4 * i + 2]!]!;
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
