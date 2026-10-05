/**
 * A stored (uncompressed) ZIP of a few files — the per-level DXFs of a multi-level export — with a
 * fixed timestamp, so the same files make the same archive. PKWARE APPNOTE 6.3, sections 4.3–4.4;
 * no compression, no extra fields, UTF-8 names (flag bit 11).
 */
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** DOS date and time of `at` (UTC): what every entry is stamped with. */
function dos(at: Date): { time: number; date: number } {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

export function storedZip(entries: readonly ZipEntry[], at: Date): Uint8Array {
  const { time, date } = dos(at);
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true);
    l.setUint16(8, 0, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, e.bytes.length, true);
    l.setUint32(22, e.bytes.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.bytes.length, true);
    c.setUint32(24, e.bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, e.bytes);
    centrals.push(central);
    offset += local.length + e.bytes.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true);
  d.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at2 = 0;
  for (const b of [...locals, ...centrals, end]) {
    out.set(b, at2);
    at2 += b.length;
  }
  return out;
}
