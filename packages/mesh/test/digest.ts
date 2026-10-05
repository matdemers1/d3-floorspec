/** A digest of every byte a meshed house hands a view: each part's key, positions and indices, in order. */
import { sha256, toHex } from '@floorspec/engine';
import type { HouseMesh } from '../src/index.js';

export function digest(m: HouseMesh): string {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const p of m.parts) {
    chunks.push(enc.encode(`${p.key}|${JSON.stringify(p.bbox)}|`));
    chunks.push(new Uint8Array(p.mesh.positions.buffer, p.mesh.positions.byteOffset, p.mesh.positions.byteLength));
    chunks.push(new Uint8Array(p.mesh.indices.buffer, p.mesh.indices.byteOffset, p.mesh.indices.byteLength));
  }
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return toHex(sha256(all));
}
