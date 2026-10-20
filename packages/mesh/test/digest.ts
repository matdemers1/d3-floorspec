/** A digest of every byte a meshed house hands a view: each part's key, positions and indices, in order. */
import { sha256, toHex } from '@floorspec/engine';
import type { HouseMesh, XrayMesh } from '../src/index.js';

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

/** A digest of X-ray's meshes (FLR-T-14.5): each one's system, level and style, positions and normals, in order. */
export function xrayDigest(meshes: readonly XrayMesh[]): string {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = meshes.flatMap((m) => [
    enc.encode(`${m.system}|${m.level}|${m.style}|${String(m.pieces)}|`),
    new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength),
    new Uint8Array(m.normals.buffer, m.normals.byteOffset, m.normals.byteLength),
  ]);
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return toHex(sha256(all));
}
