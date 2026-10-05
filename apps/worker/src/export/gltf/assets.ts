/**
 * The maps a 3D export embeds, read from the asset store (FLR-T-9.2 with FLR-T-8.2): the api writes
 * uploads under `ASSET_DIR` as `ab/cd/<sha256>`, and the worker mounts the same volume read-only.
 * An asset is read by the SHA-256 the document records for it, and its bytes are checked against
 * that digest and against the media type the document declares (PNG or JPEG by their signatures)
 * before they are embedded: a missing, changed or mislabelled file is left out, and the export's
 * summary says so, as for any map it cannot embed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ImageSource } from './glb.js';

const SHA256 = /^[0-9a-f]{64}$/;

const SIGNATURES: Readonly<Record<string, readonly number[]>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/** True when `bytes` begin with the signature of `mediaType` (PNG or JPEG). */
export function looksLike(bytes: Uint8Array, mediaType: string): boolean {
  const sig = SIGNATURES[mediaType];
  return sig !== undefined && bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/** An `images` source over a content-addressed asset directory; undefined when there is no directory. */
export function assetDirImages(dir: string | undefined): ImageSource | undefined {
  if (dir === undefined || dir === '') return undefined;
  const root = resolve(dir);
  return ({ sha256, mediaType }) => {
    if (!SHA256.test(sha256) || SIGNATURES[mediaType] === undefined) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)));
    } catch {
      return undefined;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return undefined;
    return looksLike(bytes, mediaType) ? bytes : undefined;
  };
}
