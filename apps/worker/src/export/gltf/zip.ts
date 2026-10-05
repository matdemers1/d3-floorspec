/**
 * The ZIP a USDZ is (FLR-T-9.2): every file stored, never compressed, and every file's data starting
 * at a multiple of 64 bytes from the start of the archive — what the USDZ specification asks, so a
 * reader can map the archive and use each file in place. The padding goes in each local header's
 * extra field. No dates (every entry says 1980-01-01), so the same files give the same bytes.
 */
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const ALIGN = 64;
/** An extra field ID that no reader interprets: padding. */
const PADDING_ID = 0x1986;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

export function storeZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(e.bytes) >>> 0;
    const headerEnd = offset + 30 + name.byteLength;
    let pad = (ALIGN - (headerEnd % ALIGN)) % ALIGN;
    if (pad > 0 && pad < 4) pad += ALIGN;
    const local = new Uint8Array(30 + name.byteLength + pad);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 10, true); // version needed: stored
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.bytes.byteLength, true);
    lv.setUint32(22, e.bytes.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, pad, true);
    local.set(name, 30);
    if (pad > 0) {
      lv.setUint16(30 + name.byteLength, PADDING_ID, true);
      lv.setUint16(32 + name.byteLength, pad - 4, true);
    }
    const cd = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 10, true); // made by
    cv.setUint16(6, 10, true); // needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.bytes.byteLength, true);
    cv.setUint32(24, e.bytes.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    parts.push(local, e.bytes);
    offset += local.byteLength + e.bytes.byteLength;
  }
  const cdSize = central.reduce((n, c) => n + c.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The entries of a stored ZIP and where each one's data starts (tests: alignment, contents). */
export function readStoreZip(zip: Uint8Array): { name: string; offset: number; method: number; bytes: Uint8Array }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: { name: string; offset: number; method: number; bytes: Uint8Array }[] = [];
  let at = 0;
  while (at + 30 <= zip.byteLength && v.getUint32(at, true) === 0x04034b50) {
    const method = v.getUint16(at + 8, true);
    const size = v.getUint32(at + 18, true);
    const n = v.getUint16(at + 26, true);
    const extra = v.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + n));
    const offset = at + 30 + n + extra;
    out.push({ name, offset, method, bytes: zip.subarray(offset, offset + size) });
    at = offset + size;
  }
  return out;
}
