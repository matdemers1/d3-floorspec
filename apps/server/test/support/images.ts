import { crc32, deflateSync } from 'node:zlib';

/**
 * Small, real image files built byte by byte for the asset tests (FLR-T-8.2): a PNG that decodes,
 * with metadata chunks a camera or an editor would leave in it, and JPEG and WebP containers whose
 * structure — not their pixels — is what the store reads and strips.
 */

const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
};
const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat(text(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

/**
 * A `width` × `height` RGB PNG of square tiles, `tile` px each, with grout lines: something a person
 * can see is tiled at the right scale. `meta` adds a tEXt chunk and an eXIf chunk with a GPS tag.
 */
export function tilePng(width: number, height: number, options: { tile?: number; meta?: boolean; colour?: [number, number, number] } = {}): Uint8Array {
  const tile = options.tile ?? Math.max(1, Math.floor(width / 4));
  const [r, g, b] = options.colour ?? [94, 166, 160];
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const grout = x % tile < Math.max(1, tile / 16) || y % tile < Math.max(1, tile / 16);
      // A darker mark in each tile's top-left corner, so a mirrored or upside-down tile shows.
      const mark = x % tile > tile / 8 && x % tile < tile / 3 && y % tile > tile / 8 && y % tile < tile / 4;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const c: [number, number, number] = grout ? [238, 236, 230] : mark ? [r - 40, g - 40, b - 40] : [r, g, b];
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  const ihdr = concat(u32be(width), u32be(height), new Uint8Array([8, 2, 0, 0, 0]));
  const chunks = [pngChunk('IHDR', ihdr)];
  if (options.meta === true) {
    chunks.push(pngChunk('tEXt', text('Author\u0000Somebody at 12 Example Lane')));
    chunks.push(pngChunk('eXIf', concat(text('MM\u0000*'), text('GPSLatitude 42.3601 N'))));
  }
  chunks.push(pngChunk('IDAT', new Uint8Array(deflateSync(raw))));
  chunks.push(pngChunk('IEND', new Uint8Array()));
  return concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks);
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data);
}

/**
 * The structure of a baseline JPEG: JFIF, an EXIF APP1 with a GPS position, an XMP APP1, an ICC
 * profile in APP2, a comment, a frame header of `width` × `height`, and a scan. The scan's bytes are
 * not a picture; nothing here decodes them.
 */
export function jpegWithExif(width: number, height: number): Uint8Array {
  const sof = new Uint8Array([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  return concat(
    new Uint8Array([0xff, 0xd8]),
    segment(0xe0, concat(text('JFIF\u0000'), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]))),
    segment(0xe1, concat(text('Exif\u0000\u0000MM\u0000*'), text('GPSLatitude 42.3601 N GPSLongitude 71.0589 W'))),
    segment(0xe1, text('http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta>Somebody</x:xmpmeta>')),
    segment(0xe2, text('ICC_PROFILE\u0000\u0001\u0001sRGB')),
    segment(0xfe, text('taken at the house')),
    segment(0xc0, sof),
    segment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
    new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
  );
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? new Uint8Array([0]) : new Uint8Array();
  return concat(text(type), u32le(data.length), data, pad);
}

/** An extended WebP: VP8X (with the EXIF and XMP flags set), a VP8L frame header, EXIF and XMP chunks. */
export function webpWithExif(width: number, height: number): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08 | 0x04;
  vp8x.set(u32le(width - 1).subarray(0, 3), 4);
  vp8x.set(u32le(height - 1).subarray(0, 3), 7);
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = concat(new Uint8Array([0x2f]), u32le(bits), new Uint8Array([1, 2, 3]));
  const body = concat(text('WEBP'), riffChunk('VP8X', vp8x), riffChunk('VP8L', vp8l), riffChunk('EXIF', text('MM\u0000*GPS 42 N')), riffChunk('XMP ', text('<x:xmpmeta/>')));
  return concat(text('RIFF'), u32le(body.length), body);
}

/** A KTX2 header for a `width` × `height` texture, and nothing after it worth reading. */
export function ktx2(width: number, height: number): Uint8Array {
  const b = new Uint8Array(96);
  b.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set(u32le(37), 12);
  b.set(u32le(1), 16);
  b.set(u32le(width), 20);
  b.set(u32le(height), 24);
  return b;
}
