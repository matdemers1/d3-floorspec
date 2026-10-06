/**
 * FLR-T-12.10: every export reads a model as the editor does (OFFICIAL_READER), which implements
 * FS_furniture 0.1.0 — and that requires every piece to carry a fallback model and a plan symbol
 * (12.4.2, FS-INV-603). Some Core conformance examples (002-kitchen-options, 034-fridge-in-each-option)
 * were written for a core-only reader and place bare boxes with no category (FS_furniture 2.2 requires
 * one, FS-FURN-SCH-001) and no model or symbol; the editor calls them invalid.
 *
 * `withFurnitureFallbacks` completes those pieces, and nothing else: a piece with no category is
 * `other` (2.5), and its model and symbol are the starter library's refrigerator's (the pieces are
 * refrigerators), so a test can export the same kitchen as the editor reads it.
 */
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

interface LibraryFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteLength: number;
}

const LIBRARY = new URL('../../../../packages/engine/standard/registry/FS_furniture/library/library.json', import.meta.url);
const fridge = (JSON.parse(readFileSync(LIBRARY, 'utf8')) as { items: { 'refrigerator-900': { model: LibraryFile; symbol: LibraryFile } } }).items['refrigerator-900'];

/** The asset IDs the completed pieces name. */
export const FRIDGE_MODEL = 'FRIDGE';
export const FRIDGE_SYMBOL = 'FRIDGE-SYMBOL';

/** A copy of `doc` in which every FS_furniture piece carries a fallback model and symbol. */
export function withFurnitureFallbacks(doc: Json, model: LibraryFile = fridge.model): Json {
  const out = structuredClone(doc);
  const pieces = ((out['extensions'] as Json | undefined)?.['FS_furniture'] as { collections?: { pieces?: Record<string, { category?: string; fallback: Json }> } } | undefined)?.collections?.pieces ?? {};
  for (const piece of Object.values(pieces)) {
    piece.category ??= 'other';
    piece.fallback['asset'] ??= FRIDGE_MODEL;
    piece.fallback['symbol'] ??= FRIDGE_SYMBOL;
  }
  const assets = { ...((out['assets'] as Json | undefined) ?? {}) };
  assets[FRIDGE_MODEL] ??= { path: `assets/${model.path.split('/').pop() ?? 'refrigerator-900.glb'}`, sha256: model.sha256, mediaType: model.mediaType, byteLength: model.byteLength };
  assets[FRIDGE_SYMBOL] ??= { path: 'assets/refrigerator-900.svg', sha256: fridge.symbol.sha256, mediaType: fridge.symbol.mediaType, byteLength: fridge.symbol.byteLength };
  out['assets'] = assets;
  return out;
}
