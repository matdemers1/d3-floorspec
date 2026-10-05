import type { Tx } from '../db.js';
import { SHA256 } from './store.js';

/**
 * Which stored files a version of a project may reach (FLR-T-8.2's rule, for any version): the
 * files the project itself uploaded or imported, and the files its document names that its owner
 * uploaded into another of their projects (a material copied from one house to the next). A digest
 * alone is never enough — a file somebody else uploaded is unreachable even when a document names
 * it — so a package export (FLR-T-9.1) cannot be used to ask the
 * store for another account's file.
 *
 * The owner's own route (src/routes/assets.ts) applies the same rule to main's head.
 */

export interface ReachableFile {
  readonly sha256: string;
  readonly mediaType: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The digests a document's assets name, by asset ID order, each once. */
export function digestsNamed(document: unknown): string[] {
  const assets = isObject(document) && isObject(document['assets']) ? document['assets'] : {};
  const out = new Set<string>();
  for (const a of Object.values(assets)) if (isObject(a) && typeof a['sha256'] === 'string' && SHA256.test(a['sha256'])) out.add(a['sha256']);
  return [...out];
}

/**
 * The files of `document` this project may reach, by digest — only those the document names. Two
 * queries, whatever the number of assets.
 */
export async function reachableFiles(db: Pick<Tx, 'projectAsset'>, project: { readonly id: string; readonly ownerAccountId: string }, document: unknown): Promise<Map<string, ReachableFile>> {
  const named = digestsNamed(document);
  const out = new Map<string, ReachableFile>();
  if (named.length === 0) return out;
  const own = await db.projectAsset.findMany({ where: { projectId: project.id, sha256: { in: named } }, select: { sha256: true, mediaType: true } });
  for (const r of own) out.set(r.sha256, r);
  const rest = named.filter((s) => !out.has(s));
  if (rest.length > 0) {
    const owners = await db.projectAsset.findMany({ where: { sha256: { in: rest }, project: { ownerAccountId: project.ownerAccountId } }, select: { sha256: true, mediaType: true }, orderBy: { createdAt: 'asc' } });
    for (const r of owners) if (!out.has(r.sha256)) out.set(r.sha256, r);
  }
  return out;
}
