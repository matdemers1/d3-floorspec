/**
 * Radiance RGBE (`.hdr`) pictures, read and written (FLR-T-13.9): the sky maps every view lights a
 * house with are kept in this format — Greg Ward's shared-exponent RGB, run-length encoded per
 * scanline, as Poly Haven publishes them. Isomorphic: bytes in, linear floats out, no decoder
 * library and nothing of Node's or the DOM's.
 */

export interface HdrImage {
  readonly width: number;
  readonly height: number;
  /** Linear RGB, three floats a pixel, rows top to bottom. */
  readonly data: Float32Array;
}

const NEWLINE = 0x0a;

/** Decode a Radiance `.hdr` (`32-bit_rle_rgbe`, `-Y h +X w`). Throws for anything else. */
export function decodeHdr(bytes: Uint8Array): HdrImage {
  let at = 0;
  const line = (): string => {
    let s = '';
    while (at < bytes.length && bytes[at] !== NEWLINE) s += String.fromCharCode(bytes[at++]!);
    at++;
    return s;
  };
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('not a Radiance picture');
  let format = '';
  for (;;) {
    if (at >= bytes.length) throw new Error('a Radiance picture without a size');
    const l = line();
    if (l === '') break;
    if (l.startsWith('FORMAT=')) format = l.slice(7);
  }
  if (format !== '' && format !== '32-bit_rle_rgbe') throw new Error(`a Radiance picture in ${format}, not RGBE`);
  const size = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (size === null) throw new Error('a Radiance picture not stored top to bottom, left to right');
  const height = Number(size[1]);
  const width = Number(size[2]);
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (width >= 8 && width < 32768 && bytes[at] === 2 && bytes[at + 1] === 2 && ((bytes[at + 2]! << 8) | bytes[at + 3]!) === width) {
      // New-style run-length encoding: each of the four channels in turn.
      at += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let n = bytes[at++]!;
          if (n > 128) {
            n -= 128;
            const v = bytes[at++]!;
            for (let k = 0; k < n; k++) scan[4 * x++ + c] = v;
          } else {
            for (let k = 0; k < n; k++) scan[4 * x++ + c] = bytes[at++]!;
          }
        }
      }
    } else {
      // Flat (and old-style, which no current writer uses): four bytes a pixel.
      for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) scan[4 * x + c] = bytes[at++]!;
    }
    if (at > bytes.length) throw new Error('a Radiance picture cut short');
    for (let x = 0; x < width; x++) {
      const e = scan[4 * x + 3]!;
      const o = 3 * (y * width + x);
      if (e === 0) {
        data[o] = data[o + 1] = data[o + 2] = 0;
        continue;
      }
      const f = 2 ** (e - 136);
      data[o] = (scan[4 * x]! + 0.5) * f;
      data[o + 1] = (scan[4 * x + 1]! + 0.5) * f;
      data[o + 2] = (scan[4 * x + 2]! + 0.5) * f;
    }
  }
  return { width, height, data };
}

/** Encode linear RGB as a run-length-encoded Radiance `.hdr`. */
export function encodeHdr(image: HdrImage): Uint8Array {
  const { width, height, data } = image;
  const head = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${String(height)} +X ${String(width)}\n`;
  const out: number[] = [];
  for (let i = 0; i < head.length; i++) out.push(head.charCodeAt(i));
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = 3 * (y * width + x);
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      const m = Math.max(r, g, b);
      if (!(m > 1e-32)) {
        scan[4 * x] = scan[4 * x + 1] = scan[4 * x + 2] = scan[4 * x + 3] = 0;
        continue;
      }
      const e = Math.ceil(Math.log2(m) + 1e-9);
      const f = 256 / 2 ** e;
      scan[4 * x] = Math.min(255, Math.floor(r * f));
      scan[4 * x + 1] = Math.min(255, Math.floor(g * f));
      scan[4 * x + 2] = Math.min(255, Math.floor(b * f));
      scan[4 * x + 3] = e + 128;
    }
    out.push(2, 2, (width >> 8) & 0xff, width & 0xff);
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        // A run of three or more the same, else a literal stretch up to the next run.
        let run = 1;
        while (x + run < width && run < 127 && scan[4 * (x + run) + c] === scan[4 * x + c]) run++;
        if (run >= 3) {
          out.push(128 + run, scan[4 * x + c]!);
          x += run;
          continue;
        }
        let n = 0;
        while (x + n < width && n < 128) {
          const at = x + n;
          if (at + 2 < width && scan[4 * at + c] === scan[4 * (at + 1) + c] && scan[4 * at + c] === scan[4 * (at + 2) + c]) break;
          n++;
        }
        out.push(n);
        for (let k = 0; k < n; k++) out.push(scan[4 * (x + k) + c]!);
        x += n;
      }
    }
  }
  return Uint8Array.from(out);
}
