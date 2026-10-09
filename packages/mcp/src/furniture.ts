import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import index from './library/fs-furniture-0.1.0.json' with { type: 'json' };
import type { Op } from './client.js';

/**
 * The FS_furniture starter library 0.1.0 (CC0-1.0; FS_furniture chapter 7) through MCP, as the
 * editor's furniture panel offers it (apps/web/src/furniture): an agent names an item in a
 * `placeElement`'s `catalogue` — `{"catalogue":"sofa-2100"}` — and the tools fill in the rest of
 * the element from the library: category, name, seats, the box and default envelopes, and
 * `fallback.asset` and `fallback.symbol`. Furnishing a house by hand had taken 38 asset operations
 * with SHA-256 digests copied out of library.json (FLR-T-12.25).
 *
 * As the editor does (apps/web/src/furniture/ops.ts), one batch then carries:
 *   - FS_furniture in `extensionsUsed`, when neither the plan nor the batch declares it;
 *   - an asset for each item's model and one for its symbol — unless the plan or the batch already
 *     has an asset with those bytes (one digest, one asset: FS_furniture 3.4) — under IDs named for
 *     the item (`sofa-2100-model`), so a head that turns out to hold them already drops them;
 *   - the agent's own placeElement, completed.
 * Every one is a plain Floorspec Op (FLR-ADR-008). The files themselves are uploaded into the
 * project's asset store through the ordinary asset route before the batch is sent (server.ts), so
 * the asset entries point at bytes the server has and serves — the same route the editor uses.
 *
 * The copy here is vendored by scripts/vendor-furniture.mjs from packages/engine/standard, files
 * in base64; a test holds it to the standard's byte for byte.
 */

export type FurnitureKind = 'pieces' | 'appliances' | 'casework';

export interface LibraryFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface Item {
  readonly kind: FurnitureKind;
  readonly mounting: string;
  readonly element: { readonly category: string; readonly catalogue: string; readonly name: string; readonly seats?: number; readonly clearances?: Record<string, unknown>; readonly fallback: { readonly box: unknown } };
  readonly model: LibraryFile;
  readonly symbol: LibraryFile;
}

const LIBRARY = index as unknown as { library: string; extension: string; version: string; license: string; items: Record<string, Item>; files: Record<string, string> };
const ITEMS = LIBRARY.items;

export const EXTENSION = 'FS_furniture';
export const FS_FURNITURE = { library: LIBRARY.library, version: LIBRARY.version, license: LIBRARY.license };
const EXTENSION_VERSION = OFFICIAL_EXTENSIONS.find((e) => e.name === EXTENSION)?.version ?? '0.1.0';

/** The library's item IDs by kind, for telling an agent what it can name. */
export function furnitureItems(): Record<FurnitureKind, string[]> {
  const out: Record<FurnitureKind, string[]> = { pieces: [], appliances: [], casework: [] };
  for (const [id, item] of Object.entries(ITEMS)) out[item.kind].push(id);
  return out;
}

/** One line naming every library item, for a tool result. */
export function furnitureText(): string {
  const t = furnitureItems();
  return (
    `Furniture: placeElement FS_furniture with element {"catalogue":"<item>"} and the library fills in the rest — ` +
    `pieces: ${t.pieces.join(', ')}; appliances: ${t.appliances.join(', ')}; casework: ${t.casework.join(', ')}.`
  );
}

/** A library file's bytes. */
export function libraryFileBytes(file: LibraryFile): Uint8Array {
  const b64 = LIBRARY.files[file.path];
  if (b64 === undefined) throw new Error(`the vendored FS_furniture library has no file ${file.path}`);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** The vendored library as the standard has it (library.json), and its files — for the test that keeps them in step. */
export function vendoredFurniture(): { library: Record<string, unknown>; files: Record<string, string> } {
  const { files, ...library } = LIBRARY;
  return { library, files };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A placeElement of FS_furniture that names a catalogue item and leaves a member for the library to fill. */
function catalogueOf(op: Op): string | null {
  if (op.op !== 'placeElement' || op['extension'] !== EXTENSION || !isObject(op['element'])) return null;
  const catalogue = op['element']['catalogue'];
  if (typeof catalogue !== 'string') return null;
  const fallback = op['element']['fallback'];
  const missing = !isObject(fallback) || fallback['asset'] === undefined || fallback['symbol'] === undefined || fallback['box'] === undefined;
  return missing ? catalogue : null;
}

/** True when a batch places a library item by its catalogue ID: only then is the plan worth reading for it. */
export function namesFurniture(batch: readonly Op[]): boolean {
  return batch.some((op) => catalogueOf(op) !== null);
}

/** An item the agent named that the library does not have, or put in another kind's collection: what to say. */
export class CatalogueError extends Error {}

/** What filling a batch's catalogue placements produced. */
export interface FurnitureFill {
  /** The operations to put first: the extension's declaration and the new assets. */
  readonly prefix: readonly Op[];
  /** The agent's batch with each catalogue placement completed (same length, same order). */
  readonly batch: readonly Op[];
  /** The library items placed, once each. */
  readonly items: readonly string[];
  /** Every library file those placements name, once each: what to upload. */
  readonly files: readonly LibraryFile[];
}

/** The assets a document or a batch holds, by digest: one digest, one asset. */
function assetsByDigest(document: unknown, batch: readonly Op[]): Map<string, string> {
  const out = new Map<string, string>();
  const assets = isObject(document) && isObject(document['assets']) ? document['assets'] : {};
  for (const [id, a] of Object.entries(assets)) if (isObject(a) && typeof a['sha256'] === 'string' && !out.has(a['sha256'])) out.set(a['sha256'], id);
  for (const op of batch) {
    if (op.op !== 'addElement' || op['collection'] !== 'assets' || typeof op['id'] !== 'string' || !isObject(op['element'])) continue;
    const sha = op['element']['sha256'];
    if (typeof sha === 'string' && !out.has(sha)) out.set(sha, op['id']);
  }
  return out;
}

/**
 * Every ID the document might hold — the keys of its top-level members (the Core collections among
 * them) and of each extension's collections (`extensions.<ext>.collections.<c>`) — and every ID the
 * batch gives. Erring wide only skips a name.
 */
function usedIds(document: unknown, batch: readonly Op[]): Set<string> {
  const used = new Set<string>();
  const keys = (v: unknown) => {
    if (isObject(v)) for (const id of Object.keys(v)) used.add(id);
  };
  if (isObject(document)) {
    for (const [key, value] of Object.entries(document)) {
      if (key !== 'extensions') keys(value);
      else if (isObject(value)) for (const ext of Object.values(value)) if (isObject(ext) && isObject(ext['collections'])) for (const c of Object.values(ext['collections'])) keys(c);
    }
  }
  for (const op of batch) if (typeof op['id'] === 'string') used.add(op['id']);
  return used;
}

/** True when the plan or the batch declares FS_furniture. */
function declared(document: unknown, batch: readonly Op[]): boolean {
  const used = isObject(document) ? document['extensionsUsed'] : undefined;
  if (isObject(used) && Object.hasOwn(used, EXTENSION)) return true;
  return batch.some(
    (op) =>
      op.op === 'setProperty' &&
      op['id'] === '$document' &&
      (op['path'] === `/extensionsUsed/${EXTENSION}` || (op['path'] === '/extensionsUsed' && isObject(op['value']) && Object.hasOwn(op['value'], EXTENSION))),
  );
}

const EXT: Readonly<Record<string, string>> = { 'model/gltf-binary': 'glb', 'image/svg+xml': 'svg', 'image/png': 'png' };

/** The asset entry for a library file, at the path the server's asset store gives it (Core 18.4). */
function assetEntry(file: LibraryFile): Json {
  return {
    path: `assets/${file.sha256}.${EXT[file.mediaType] ?? 'bin'}`,
    sha256: file.sha256,
    mediaType: file.mediaType,
    byteLength: file.byteLength,
    name: file.path.split('/').at(-1) ?? file.path,
  };
}

/**
 * Complete every catalogue placement in a batch from the library, and the operations to put ahead
 * of it. Members the agent gave are kept; only those it left out are filled. An unknown item, or a
 * known one in another kind's collection, is a CatalogueError the agent can act on.
 */
export function fillFurniture(document: unknown, batch: readonly Op[]): FurnitureFill {
  const prefix: Op[] = [];
  const items: string[] = [];
  const files = new Map<string, LibraryFile>();
  const byDigest = assetsByDigest(document, batch);
  const used = usedIds(document, batch);

  /** The asset for a library file: one the plan or batch has with its digest, else a new one. */
  const assetFor = (item: string, role: 'model' | 'symbol', file: LibraryFile): string => {
    files.set(file.sha256, file);
    const existing = byDigest.get(file.sha256);
    if (existing !== undefined) return existing;
    let id = `${item}-${role}`;
    for (let n = 2; used.has(id); n++) id = `${item}-${role}-${String(n)}`;
    used.add(id);
    byDigest.set(file.sha256, id);
    prefix.push({ op: 'addElement', collection: 'assets', id, element: assetEntry(file) });
    return id;
  };

  const out = batch.map((op) => {
    const catalogue = catalogueOf(op);
    if (catalogue === null) return op;
    const item = ITEMS[catalogue];
    if (item === undefined || !Object.hasOwn(ITEMS, catalogue)) {
      throw new CatalogueError(`No FS_furniture library item is "${catalogue}", and the element has no fallback.asset of its own. ${furnitureText()}`);
    }
    if (op['collection'] !== item.kind) throw new CatalogueError(`"${catalogue}" is in FS_furniture's "${item.kind}" collection, not "${String(op['collection'])}": place it with "collection":"${item.kind}".`);
    if (!items.includes(catalogue)) items.push(catalogue);
    const given = op['element'] as Json;
    const givenFallback = isObject(given['fallback']) ? given['fallback'] : {};
    const { seats, clearances } = item.element;
    const element: Json = {
      category: item.element.category,
      name: item.element.name,
      ...(seats === undefined ? {} : { seats }),
      ...(clearances === undefined ? {} : { clearances: structuredClone(clearances) }),
      ...given,
      fallback: {
        box: structuredClone(item.element.fallback.box),
        ...givenFallback,
        ...(givenFallback['asset'] === undefined ? { asset: assetFor(catalogue, 'model', item.model) } : {}),
        ...(givenFallback['symbol'] === undefined ? { symbol: assetFor(catalogue, 'symbol', item.symbol) } : {}),
      },
    };
    return { ...op, element };
  });

  if (items.length > 0 && !declared(document, batch)) prefix.unshift({ op: 'setProperty', id: '$document', path: `/extensionsUsed/${EXTENSION}`, value: EXTENSION_VERSION });
  return { prefix, batch: out, items, files: [...files.values()] };
}
