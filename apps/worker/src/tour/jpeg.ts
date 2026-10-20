/**
 * A baseline JPEG encoder (ITU-T T.81): 8-bit RGB in, a JFIF file out — 4:2:0 chroma, the standard
 * quantization tables scaled by a quality (IJG's scale), the standard Huffman tables. A virtual
 * tour's panoramas (FLR-T-14.2) are photographs a phone downloads one room at a time, so they are
 * JPEGs, not PNGs: a 4096 × 2048 panorama is a megabyte or two rather than twenty.
 *
 * Plain arithmetic and nothing else, so the same pixels always make the same bytes.
 */

const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30,
  37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** T.81 Annex K: the luminance and chrominance quantization tables, in natural (row) order. */
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81,
  104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** T.81 Annex K.3: the typical Huffman tables — code counts by length, then the values. */
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  values: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15,
    0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43,
    0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
    0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3,
    0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  values: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23,
    0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77,
    0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

interface Huffman {
  readonly code: Uint16Array;
  readonly size: Uint8Array;
}

/** T.81 Annex C: each value's code and its length, from the counts by length. */
function huffman(spec: { bits: number[]; values: number[] }): Huffman {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < spec.bits[len - 1]!; i++) {
      const v = spec.values[k++]!;
      code[v] = c++;
      size[v] = len;
    }
    c <<= 1;
  }
  return { code, size };
}

const H = { dcY: huffman(DC_LUMA), acY: huffman(AC_LUMA), dcC: huffman(DC_CHROMA), acC: huffman(AC_CHROMA) };

/** A quantization table at a quality (1–100), IJG's way, in natural order. */
function scaled(base: readonly number[], quality: number): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return Uint8Array.from(base, (t) => Math.max(1, Math.min(255, Math.floor((t * scale + 50) / 100))));
}

/** cos((2x+1)uπ/16), with the DCT's normalisation folded in: C(u)/2. */
const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) t[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();

class Bits {
  private bytes: Uint8Array;
  private length = 0;
  private acc = 0;
  private count = 0;
  constructor(capacity: number) {
    this.bytes = new Uint8Array(Math.max(1024, capacity));
  }
  byte(b: number): void {
    if (this.length >= this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = b;
  }
  raw(data: readonly number[] | Uint8Array): void {
    for (const b of data) this.byte(b);
  }
  word(w: number): void {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }
  /** `n` bits of `value`, most significant first, with a stuffed zero after each 0xFF of the scan. */
  put(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.count === 8) {
        this.byte(this.acc);
        if (this.acc === 0xff) this.byte(0);
        this.acc = 0;
        this.count = 0;
      }
    }
  }
  /** Pad the last byte of the scan with ones. */
  flush(): void {
    if (this.count > 0) this.put((1 << (8 - this.count)) - 1, 8 - this.count);
  }
  done(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** The bits a value of the DC difference or an AC coefficient takes: its category and its bits. */
function category(v: number): number {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a > 0) {
    n++;
    a >>= 1;
  }
  return n;
}

/** Forward DCT of a block (level-shifted samples) into `out`, quantized and in zigzag order. */
function dctQuantize(block: Float64Array, q: Uint8Array, tmp: Float64Array, out: Int32Array): void {
  // Rows, then columns.
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += COS[u * 8 + x]! * block[y * 8 + x]!;
      tmp[y * 8 + u] = s;
    }
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += COS[v * 8 + y]! * tmp[y * 8 + u]!;
      const natural = v * 8 + u;
      block[natural] = s;
    }
  for (let i = 0; i < 64; i++) {
    const natural = ZIGZAG[i]!;
    out[i] = Math.round(block[natural]! / q[natural]!);
  }
}

function encodeBlock(bits: Bits, coef: Int32Array, prevDc: number, dc: Huffman, ac: Huffman): number {
  const diff = coef[0]! - prevDc;
  const c = category(diff);
  bits.put(dc.code[c]!, dc.size[c]!);
  if (c > 0) bits.put(diff < 0 ? diff - 1 + (1 << c) : diff, c);
  let run = 0;
  for (let i = 1; i < 64; i++) {
    const v = coef[i]!;
    if (v === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      bits.put(ac.code[0xf0]!, ac.size[0xf0]!);
      run -= 16;
    }
    const n = category(v);
    const sym = (run << 4) | n;
    bits.put(ac.code[sym]!, ac.size[sym]!);
    bits.put(v < 0 ? v - 1 + (1 << n) : v, n);
    run = 0;
  }
  if (run > 0) bits.put(ac.code[0]!, ac.size[0]!);
  return coef[0]!;
}

function dht(bits: Bits, cls: number, id: number, spec: { bits: number[]; values: number[] }): void {
  bits.word(0xffc4);
  bits.word(2 + 1 + 16 + spec.values.length);
  bits.byte((cls << 4) | id);
  bits.raw(spec.bits);
  bits.raw(spec.values);
}

/**
 * Encode 8-bit RGB (three bytes a pixel, rows top to bottom) as a baseline JFIF JPEG at a quality of
 * 1–100 (default 85), chroma subsampled 4:2:0.
 */
export function encodeJpeg(rgb: Uint8Array, width: number, height: number, quality = 85): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) throw new RangeError('a JPEG is 1 to 65535 pixels on a side');
  if (rgb.byteLength !== width * height * 3) throw new RangeError('the pixels are not width × height × 3 bytes');
  const qY = scaled(LUMA_Q, quality);
  const qC = scaled(CHROMA_Q, quality);
  const bits = new Bits(Math.ceil(width * height * 0.4) + 1024);

  // Headers: SOI, JFIF, the two tables, the frame (Y 2×2, Cb and Cr 1×1), the four Huffman tables, the scan.
  bits.word(0xffd8);
  bits.word(0xffe0);
  bits.word(16);
  bits.raw([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  bits.word(0xffdb);
  bits.word(2 + 2 * 65);
  bits.byte(0);
  for (let i = 0; i < 64; i++) bits.byte(qY[ZIGZAG[i]!]!);
  bits.byte(1);
  for (let i = 0; i < 64; i++) bits.byte(qC[ZIGZAG[i]!]!);
  bits.word(0xffc0);
  bits.word(17);
  bits.byte(8);
  bits.word(height);
  bits.word(width);
  bits.byte(3);
  bits.raw([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  dht(bits, 0, 0, DC_LUMA);
  dht(bits, 1, 0, AC_LUMA);
  dht(bits, 0, 1, DC_CHROMA);
  dht(bits, 1, 1, AC_CHROMA);
  bits.word(0xffda);
  bits.word(12);
  bits.byte(3);
  bits.raw([1, 0x00, 2, 0x11, 3, 0x11]);
  bits.raw([0, 63, 0]);

  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Int32Array(64);
  const cb = new Float64Array(64);
  const cr = new Float64Array(64);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;
  const at = (x: number, y: number): number => 3 * (Math.min(height - 1, y) * width + Math.min(width - 1, x));
  for (let my = 0; my < height; my += 16)
    for (let mx = 0; mx < width; mx += 16) {
      cb.fill(0);
      cr.fill(0);
      for (let by = 0; by < 2; by++)
        for (let bx = 0; bx < 2; bx++) {
          for (let y = 0; y < 8; y++)
            for (let x = 0; x < 8; x++) {
              const px = mx + bx * 8 + x;
              const py = my + by * 8 + y;
              const i = at(px, py);
              const r = rgb[i]!;
              const g = rgb[i + 1]!;
              const b = rgb[i + 2]!;
              block[y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
              // Each chroma sample is the mean of a 2 × 2 square of pixels.
              const c = ((by * 8 + y) >> 1) * 8 + ((bx * 8 + x) >> 1);
              cb[c] = cb[c]! + (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
              cr[c] = cr[c]! + (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
            }
          dctQuantize(block, qY, tmp, coef);
          dcY = encodeBlock(bits, coef, dcY, H.dcY, H.acY);
        }
      dctQuantize(cb, qC, tmp, coef);
      dcCb = encodeBlock(bits, coef, dcCb, H.dcC, H.acC);
      dctQuantize(cr, qC, tmp, coef);
      dcCr = encodeBlock(bits, coef, dcCr, H.dcC, H.acC);
    }
  bits.flush();
  bits.word(0xffd9);
  return bits.done();
}
