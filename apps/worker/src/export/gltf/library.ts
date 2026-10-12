/**
 * The material library's maps (FLR-T-13.6, `@floorspec/mesh/materials`), read from the files the
 * package ships: what a model's pieces are drawn in, and the bytes of any library map a document
 * names that the project's asset store does not hold — embedded by an agent's batch without an
 * upload, say. A library file is the app's own, the same bytes for everyone, so it is read whoever
 * asks; each is read once and checked against its digest.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LIBRARY_FILES, libraryFileOf } from '@floorspec/mesh/materials';
import type { ImageSource } from './glb.js';

const require = createRequire(import.meta.url);
const cache = new Map<string, Uint8Array | null>();

/** A library map's bytes by digest, or undefined when no library file has it. */
export function libraryBytes(sha256: string): Uint8Array | undefined {
  const file = libraryFileOf(sha256);
  if (file === undefined) return undefined;
  let bytes = cache.get(file);
  if (bytes === undefined) {
    try {
      const b = new Uint8Array(readFileSync(require.resolve(`@floorspec/mesh/materials/${file}`)));
      bytes = createHash('sha256').update(b).digest('hex') === LIBRARY_FILES[file]!.sha256 ? b : null;
    } catch {
      bytes = null;
    }
    cache.set(file, bytes);
  }
  return bytes ?? undefined;
}

/** A source that falls back to the library's files for a library digest the given source (if any) cannot supply. */
export function withLibrary(source: ImageSource | undefined): ImageSource {
  return (asset) => source?.(asset) ?? (asset.mediaType === 'image/jpeg' ? libraryBytes(asset.sha256) : undefined);
}
