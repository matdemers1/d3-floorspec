import type { Request, Response } from 'express';
import type { Tx } from '../db.js';
import { EXTENSIONS } from './media.js';
import { SHA256 } from './store.js';

/**
 * Which stored files a version of a project may reach (FLR-T-8.2's rule, for any version): the
 * files the project itself uploaded or imported, and the files its document names that its owner
 * uploaded into another of their projects (a material copied from one house to the next). A digest
 * alone is never enough — a file somebody else uploaded is unreachable even when a document names
 * it — so neither a package export (FLR-T-9.1) nor a share link (FLR-T-9.6) can be used to ask the
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

/**
 * Send a stored file the way the owner's asset route does: its media type, its digest as the ETag,
 * `nosniff`, and a sandbox CSP — opened on its own, an image is shown and nothing in it runs.
 */
export function sendAssetBytes(req: Request, res: Response, file: ReachableFile, bytes: Uint8Array, cacheControl: string): void {
  const ext = (EXTENSIONS as Readonly<Record<string, string | undefined>>)[file.mediaType] ?? 'bin';
  res.setHeader('Content-Type', file.mediaType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('ETag', `"${file.sha256}"`);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `inline; filename="${file.sha256}.${ext}"`);
  if (req.get('if-none-match') === `"${file.sha256}"`) {
    res.status(304).end();
    return;
  }
  res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
}
