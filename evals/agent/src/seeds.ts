import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, evaluate } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import type { Seed } from './types.js';

/**
 * Seeds: the houses the tasks start from. A seed is a Floorspec Core document (the document seeds
 * are Core 0.1, and stay so: their hashes are what runs were scored against), or batches of
 * Floorspec Ops applied in order to an empty document. Either way the server receives it the only
 * way anything reaches a document — as Floorspec Ops (FLR-ADR-008) — so a document seed is sent as
 * operations that rebuild it exactly, its declared version included, and the harness checks the
 * hash it lands at.
 */

export const EVAL_ROOT = join(import.meta.dirname, '..');
export const SEEDS_DIR = join(EVAL_ROOT, 'seeds');

export type Doc = Record<string, unknown>;

/** The document the server creates a project with: Core 0.3, as apps/server's emptyDocument. */
export function emptyDocument(name: string): Doc {
  return { floorspec: '0.3', project: { name } };
}

/** Apply batches to a document with the reference applier; throws with the diagnostics on a rejection. */
export function applyBatches(document: Doc, batches: readonly (readonly object[])[]): Doc {
  let doc = document;
  for (const [i, batch] of batches.entries()) {
    const result = apply(doc, { batch: batch as object[] });
    if (result.status !== 'committed') {
      throw new Error(`batch ${String(i)} was rejected: ${result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    }
    doc = JSON.parse(result.document) as Doc;
  }
  return doc;
}

/** The batches that seed a project, from the empty document the server creates it with. */
export function seedBatches(seed: Seed): readonly (readonly object[])[] {
  const resolved = typeof seed === 'string' ? readSeedFile(seed) : seed;
  if ('batches' in resolved) return resolved.batches;
  return [documentToBatch(resolved.document as Doc)];
}

/** The seed as a document. */
export function seedDocument(seed: Seed): Doc {
  const resolved = typeof seed === 'string' ? readSeedFile(seed) : seed;
  if ('batches' in resolved) return applyBatches(emptyDocument('Seed'), resolved.batches);
  const doc = resolved.document as Doc;
  const ev = evaluate(doc);
  if (!ev.valid) throw new Error(`seed is not a valid Floorspec document: ${ev.diagnostics.map((d) => d.code).join(', ')}`);
  return doc;
}

const cache = new Map<string, { document: object } | { batches: readonly (readonly object[])[] }>();

function readSeedFile(name: string): { document: object } | { batches: readonly (readonly object[])[] } {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const file = name.endsWith('.json') ? name : `${name}.json`;
  const value = JSON.parse(readFileSync(join(SEEDS_DIR, file), 'utf8')) as Record<string, unknown>;
  const out = 'batches' in value ? { batches: value['batches'] as object[][] } : { document: value };
  cache.set(name, out);
  return out;
}

/** The order elements are added in: what an element refers to comes first. */
const ORDER = ['buildings', 'assets', 'materials', 'types', 'levels', 'junctions', 'walls', 'separators', 'slabs', 'rooms', 'openings'] as const;
const KNOWN = new Set<string>(['floorspec', 'project', 'site', 'extras', 'extensions', ...ORDER]);

/** One batch that turns the server's empty document into this one, with every ID kept. */
export function documentToBatch(doc: Doc): object[] {
  for (const key of Object.keys(doc)) if (!KNOWN.has(key)) throw new Error(`the seed has a member the converter does not know: ${key}`);
  // The seed's own version: a project starts at Core 0.2, and a 0.1 seed is set back to 0.1 (Ops
  // writes no declaration implicitly, so nothing else would).
  const batch: object[] = [
    { op: 'setProperty', id: '$document', path: '/floorspec', value: doc['floorspec'] },
    { op: 'setProperty', id: '$document', path: '/project', value: doc['project'] },
  ];
  for (const member of ['site', 'extras', 'extensions'] as const) {
    if (doc[member] !== undefined) batch.push({ op: 'setProperty', id: '$document', path: `/${member}`, value: doc[member] });
  }
  for (const collection of ORDER) {
    const elements = doc[collection] as Record<string, unknown> | undefined;
    if (elements === undefined) continue;
    for (const [id, element] of Object.entries(elements)) batch.push({ op: 'addElement', collection, id, element });
  }
  return batch;
}

export function hashOf(doc: object): string {
  return contentHash(doc);
}
