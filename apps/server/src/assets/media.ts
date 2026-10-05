/**
 * What an uploaded file is, read from its bytes — never from the name or the Content-Type a client
 * sent — and what of it is kept (FLR-T-8.2).
 *
 * The four image formats a texture's map may be (Core 18.2.2): PNG, JPEG, WebP and KTX2. Anything
 * else is refused. The pixel size is read from the header, so a calibration can say "1 px = …".
 *
 * **Metadata is stripped, losslessly.** A phone's photo of a tile carries EXIF, often with the GPS
 * position of the house it was taken in, and a model is shared (share links, exports, the package
 * a model travels in). So before a file is hashed and stored, the segments and chunks that carry
 * camera, location and authoring metadata are removed — JPEG APP1 (EXIF, XMP), APP13 (IPTC) and
 * comments; PNG eXIf and text chunks and tIME; WebP EXIF and XMP chunks — and nothing else is
 * touched: no pixel is decoded or re-encoded, the colour profile (JPEG APP2, PNG iCCP, WebP ICCP)
 * stays, and no image library is needed. The digest is of the stripped bytes, which are the bytes
 * served and the bytes the document's `sha256` names. One consequence: an EXIF orientation is
 * dropped with the rest, so a sideways phone photo is stored sideways — and shown the same way in
 * the calibration dialog and in 3D, never one way in one and another in the other.
 * KTX2 is stored as it came: it is a GPU texture container, not a camera's file.
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/ktx2';

export const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/ktx2': 'ktx2',
};

/** The longest side an image may have: larger than any GPU's texture limit is not a texture. */
export const MAX_DIMENSION = 16_384;

export interface Sniffed {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

export interface Prepared extends Sniffed {
  /** The bytes to store: the upload with its metadata removed. */
  readonly bytes: Uint8Array;
  /** What was removed, by segment or chunk name, for the audit trail. */
  readonly stripped: readonly string[];
}

export class MediaError extends Error {
  constructor(
    message: string,
    readonly status: 415 | 422,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2_SIGNATURE = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number): number => (((b[at] ?? 0) << 24) >>> 0) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
const u32le = (b: Uint8Array, at: number): number => (((b[at + 3] ?? 0) << 24) >>> 0) + (((b[at + 2] ?? 0) << 16) | ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0));
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);

const truncated = (what: string) => new MediaError(`this ${what} file is cut short or damaged`, 422);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

/** Chunks that say who, when and where — never how the image looks. */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function png(b: Uint8Array): Prepared {
  const keep: Uint8Array[] = [b.subarray(0, 8)];
  const stripped: string[] = [];
  let at = 8;
  let width = 0;
  let height = 0;
  let ended = false;
  while (at < b.length) {
    if (at + 12 > b.length) throw truncated('PNG');
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (end > b.length) throw truncated('PNG');
    if (type === 'IHDR') {
      width = u32be(b, at + 8);
      height = u32be(b, at + 12);
    }
    if (PNG_DROP.has(type)) stripped.push(type);
    else keep.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || width === 0) throw truncated('PNG');
  return { mediaType: 'image/png', width, height, bytes: stripped.length === 0 ? b : concat(keep), stripped };
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

/** APP1 (EXIF, XMP), APP13 (IPTC, Photoshop) and comments. APP0 (JFIF), APP2 (ICC) and APP14 (Adobe) stay. */
const JPEG_DROP: Readonly<Record<number, string>> = { 0xe1: 'APP1', 0xed: 'APP13', 0xfe: 'COM' };
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpeg(b: Uint8Array): Prepared {
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  const stripped: string[] = [];
  let at = 2;
  let width = 0;
  let height = 0;
  for (;;) {
    if (at + 4 > b.length) throw truncated('JPEG');
    if (b[at] !== 0xff) throw truncated('JPEG');
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // a fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (marker === 0xd9) throw truncated('JPEG'); // an end before any scan
    const length = u16be(b, at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > b.length) throw truncated('JPEG');
    if (isSof(marker)) {
      height = u16be(b, at + 5);
      width = u16be(b, at + 7);
    }
    if (marker === 0xda) {
      // Start of scan: everything from here — the entropy-coded data, further scans, the end — is
      // the picture, copied as it is.
      keep.push(b.subarray(at));
      break;
    }
    const drop = JPEG_DROP[marker];
    if (drop !== undefined) stripped.push(drop);
    else keep.push(b.subarray(at, end));
    at = end;
  }
  if (width === 0 || height === 0) throw truncated('JPEG');
  return { mediaType: 'image/jpeg', width, height, bytes: stripped.length === 0 ? b : concat(keep), stripped };
}

// ── WebP ─────────────────────────────────────────────────────────────────────

const WEBP_DROP = new Set(['EXIF', 'XMP ']);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function webp(b: Uint8Array): Prepared {
  if (b.length < 20) throw truncated('WebP');
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks: { type: string; bytes: Uint8Array }[] = [];
  let at = 12;
  while (at + 8 <= riffEnd) {
    const type = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const end = at + 8 + size + (size & 1);
    if (at + 8 + size > b.length) throw truncated('WebP');
    chunks.push({ type, bytes: b.subarray(at, Math.min(end, b.length)) });
    at = end;
  }
  let width = 0;
  let height = 0;
  for (const { type, bytes: c } of chunks) {
    const d = c.subarray(8);
    if (type === 'VP8X' && d.length >= 10) {
      width = u24le(d, 4) + 1;
      height = u24le(d, 7) + 1;
      break;
    }
    if (type === 'VP8 ' && d.length >= 10) {
      width = u16le(d, 6) & 0x3fff;
      height = u16le(d, 8) & 0x3fff;
      break;
    }
    if (type === 'VP8L' && d.length >= 5 && d[0] === 0x2f) {
      const bits = u32le(d, 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      break;
    }
  }
  if (width === 0 || height === 0) throw truncated('WebP');
  const stripped = chunks.filter((c) => WEBP_DROP.has(c.type)).map((c) => c.type.trim());
  if (stripped.length === 0) return { mediaType: 'image/webp', width, height, bytes: b, stripped };
  const kept = chunks
    .filter((c) => !WEBP_DROP.has(c.type))
    .map((c) => {
      if (c.type !== 'VP8X') return c.bytes;
      const copy = new Uint8Array(c.bytes);
      copy[8] = (copy[8] ?? 0) & ~(VP8X_EXIF | VP8X_XMP);
      return copy;
    });
  const body = concat(kept);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 4), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(b.subarray(8, 12), 8);
  return { mediaType: 'image/webp', width, height, bytes: concat([header, body]), stripped };
}

// ── KTX2 ─────────────────────────────────────────────────────────────────────

function ktx2(b: Uint8Array): Prepared {
  if (b.length < 80) throw truncated('KTX2');
  const width = u32le(b, 20);
  const height = Math.max(1, u32le(b, 24));
  if (width === 0) throw truncated('KTX2');
  return { mediaType: 'image/ktx2', width, height, bytes: b, stripped: [] };
}

/** What a file is by its first bytes, or null when it is none of the four. */
export function sniff(b: Uint8Array): ImageMediaType | null {
  if (startsWith(b, PNG_SIGNATURE)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (startsWith(b, KTX2_SIGNATURE)) return 'image/ktx2';
  return null;
}

/** Identify an upload, read its pixel size and strip its metadata; MediaError when it is not a texture image. */
export function prepareImage(b: Uint8Array): Prepared {
  const type = sniff(b);
  if (type === null) throw new MediaError('a texture must be a PNG, JPEG, WebP or KTX2 image', 415);
  const out = type === 'image/png' ? png(b) : type === 'image/jpeg' ? jpeg(b) : type === 'image/webp' ? webp(b) : ktx2(b);
  if (out.width > MAX_DIMENSION || out.height > MAX_DIMENSION)
    throw new MediaError(`this image is ${String(out.width)} × ${String(out.height)} px; a texture may be at most ${String(MAX_DIMENSION)} px on a side`, 422);
  return out;
}
