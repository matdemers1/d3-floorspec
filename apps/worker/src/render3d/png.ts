/** An 8-bit RGB image as a PNG: one IDAT, each row filtered by Sub, which flat shading compresses well. */
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)) >>> 0);
  return out;
}

export function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  if (rgb.byteLength !== width * height * 3) throw new RangeError('the pixels are not width × height × 3 bytes');
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1; // Sub
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x]!;
      const left = x >= 3 ? rgb[y * stride + x - 3]! : 0;
      raw[row + 1 + x] = (v - left) & 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
