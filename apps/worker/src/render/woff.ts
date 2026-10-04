import { inflateSync } from 'node:zlib';

/**
 * Unwrap a WOFF 1.0 font into the SFNT (TrueType/OpenType) it carries (W3C WOFF §3–5).
 *
 * resvg reads TTF and OTF only, and the fonts the design system ships come as WOFF/WOFF2. WOFF 1.0
 * is the SFNT's tables, each zlib-compressed or stored, so unwrapping it is exact and needs nothing
 * but zlib: the tables come back byte for byte, and so does the font.
 */
export function woffToSfnt(woff: Uint8Array): Uint8Array {
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (woff.byteLength < 44 || v.getUint32(0) !== 0x774f4646) throw new Error('not a WOFF 1.0 font');
  const flavor = v.getUint32(4);
  const numTables = v.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + 20 * i;
    const tag = v.getUint32(e);
    const offset = v.getUint32(e + 4);
    const compLength = v.getUint32(e + 8);
    const origLength = v.getUint32(e + 12);
    const checksum = v.getUint32(e + 16);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? new Uint8Array(inflateSync(raw)) : raw;
    if (data.byteLength !== origLength) throw new Error(`WOFF table ${i} inflates to ${data.byteLength} bytes, not ${origLength}`);
    tables.push({ tag, checksum, data });
  }
  tables.sort((a, b) => a.tag - b.tag);

  const pad4 = (n: number): number => (n + 3) & ~3;
  const headerSize = 12 + 16 * numTables;
  const total = tables.reduce((s, t) => s + pad4(t.data.byteLength), headerSize);
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= numTables) {
    pow *= 2;
    log++;
  }
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  o.setUint16(6, pow * 16);
  o.setUint16(8, log);
  o.setUint16(10, numTables * 16 - pow * 16);
  let at = headerSize;
  tables.forEach((t, i) => {
    const r = 12 + 16 * i;
    o.setUint32(r, t.tag);
    o.setUint32(r + 4, t.checksum);
    o.setUint32(r + 8, at);
    o.setUint32(r + 12, t.data.byteLength);
    out.set(t.data, at);
    at += pad4(t.data.byteLength);
  });
  return out;
}
