import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { embedLibraryMaterial, LIBRARY_FILES, libraryFileOf, LIBRARY_MATERIALS, libraryMaterial, MATERIAL_LIBRARY } from '@floorspec/mesh/materials';
import type { Op } from './client.js';
import { added, holds, references } from './library.js';

/**
 * The material library (FLR-T-13.6, `@floorspec/mesh/materials`) through MCP: an agent names a
 * library material wherever a material is named — `"floorFinish": "white-oak-plank"`, a layer's
 * `material`, a region's, a roof's — and the tools embed it the first time a batch does, as the US
 * starter types are: its map files as assets and the material, with its `source`, ahead of the
 * agent's own ops. Every asset a batch adds whose digest is a library file's — embedded here, or
 * written out by hand from a batch file — has that file uploaded into the project's asset store
 * first, so the plan names bytes the project holds.
 */

const require = createRequire(import.meta.url);
const ITEMS = new Set(LIBRARY_MATERIALS.map((i) => i.id));

/** The library materials a batch names that neither the document nor the batch holds: what to embed. */
export function missingLibraryMaterials(document: unknown, batch: readonly Op[]): string[] {
  const own = added(batch);
  return [...references(batch)].filter((id) => ITEMS.has(id) && !own.has(id) && !holds(document, id)).sort();
}

/** The ops that embed them, each map file once — a paint's stipple the six paints share. */
export function embedMaterialOps(document: unknown, ids: readonly string[]): Op[] {
  const pending = new Map<string, string>();
  const out: Op[] = [];
  for (const id of ids) out.push(...(embedLibraryMaterial(document, id, { id }, pending).ops as unknown as Op[]));
  return out;
}

/** The library files a batch's added assets are, by file name: what to upload before it is sent. */
export function libraryFilesAdded(batch: readonly Op[]): string[] {
  const files = new Set<string>();
  for (const op of batch) {
    if (op.op !== 'addElement' || op['collection'] !== 'assets') continue;
    const sha = (op['element'] as { sha256?: unknown } | undefined)?.sha256;
    const file = typeof sha === 'string' ? libraryFileOf(sha) : undefined;
    if (file !== undefined) files.add(file);
  }
  return [...files].sort();
}

/** A library file's bytes, from the package. */
export function materialFileBytes(file: string): Uint8Array {
  if (LIBRARY_FILES[file] === undefined) throw new Error(`the material library has no file ${file}`);
  return new Uint8Array(readFileSync(require.resolve(`@floorspec/mesh/materials/${file}`)));
}

/** One line naming the library's materials by category, for a tool result or the prompt. */
export function materialsText(): string {
  const by = new Map<string, string[]>();
  for (const i of LIBRARY_MATERIALS) by.set(i.category, [...(by.get(i.category) ?? []), i.id]);
  return (
    `Materials from the CC0 material library ${MATERIAL_LIBRARY.version} (real-size PBR textures) are embedded the first time a batch names one as a finish or a material — ` +
    [...by].map(([c, ids]) => `${c}: ${ids.join(', ')}`).join('; ') +
    '. A paint, plaster, siding or standing seam takes your colour: setProperty its /color after.'
  );
}

export { libraryMaterial };
