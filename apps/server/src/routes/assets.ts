import express, { type Request, type RequestHandler } from 'express';
import type { Db } from '../db.js';
import type { ProjectAsset } from '../generated/prisma/client.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';
import { SHA256, type AssetStore } from '../assets/store.js';
import { MediaError } from '../assets/media.js';
import { ASSET_EXTENSIONS, prepareUpload, purposeOf } from '../assets/upload.js';

/**
 * Assets (FLR-T-8.2, FLR-REQ-117, FLR-REQ-124): texture images uploaded into a project, stored by
 * the SHA-256 of their bytes in the asset store, and served back to whoever may read them.
 *
 *   POST /api/projects/:projectId/assets           the raw image as the body (any Content-Type but
 *                                                  JSON; the bytes say what it is), `X-Asset-Name`
 *                                                  its file name, percent-encoded. 201 with the
 *                                                  asset entry the document should carry.
 *                                                  `?as=model` takes a glTF 2.0 model and
 *                                                  `?as=symbol` an SVG or PNG plan symbol
 *                                                  (FLR-T-8.3, assets/upload.ts); without it, a
 *                                                  texture image.
 *   GET  /api/projects/:projectId/assets           the document's assets and the project's uploads.
 *   GET  /api/projects/:projectId/assets/:sha256   the bytes; `?download` to save them as a file
 *                                                  named as the package path's last segment.
 *
 * An upload does not change the model: every change is a Floorspec Op (FLR-ADR-008), so the editor
 * adds the asset to the document's `assets` — with the digest, media type and length answered here
 * — in the same batch as the material that uses it.
 *
 * **Who may read a file.** The store is shared by everybody's projects, so a digest alone is never
 * enough: a project reads a file it uploaded, or one its model names whose bytes its owner uploaded
 * into another of their projects (a material copied from one house to the next). A file somebody
 * else uploaded is 404 to everyone else, even with its digest in hand — so the store never answers
 * "do you have this file?" for a file the caller did not give it.
 */

/** The path a stored file has in a project's package (Core 18.4): `assets/<sha256>.<ext>`. */
export function packagePath(sha256: string, mediaType: string): string {
  const ext = (ASSET_EXTENSIONS as Readonly<Record<string, string | undefined>>)[mediaType] ?? 'bin';
  return `assets/${sha256}.${ext}`;
}

export interface AssetView {
  sha256: string;
  mediaType: string;
  byteLength: number;
  width: number;
  height: number;
  name: string | null;
  /** Where the document's asset entry should say it is (Core 18.4). */
  path: string;
  /** Where its bytes are. */
  href: string;
  uploadedAt: string;
}

export function assetView(row: ProjectAsset): AssetView {
  return {
    sha256: row.sha256,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
    width: row.width,
    height: row.height,
    name: row.name,
    path: packagePath(row.sha256, row.mediaType),
    href: `/api/projects/${row.projectId}/assets/${row.sha256}`,
    uploadedAt: row.createdAt.toISOString(),
  };
}

/** A file name for a person: its last segment, no control characters, at most 200 characters. */
export function cleanName(header: unknown): string | null {
  if (typeof header !== 'string' || header === '') return null;
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    name = header;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  name = (name.split(/[/\\]/).at(-1) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name === '' ? null : name;
}

type Json = Record<string, unknown>;

/** The model's assets (main's head), by ID, with their digests: what the document says it uses. */
async function documentAssets(db: Db, projectId: string): Promise<[string, Json][]> {
  const head = await db.head.findUnique({ where: { projectId_name: { projectId, name: MAIN } }, include: { version: true } });
  const assets = ((head?.version.document as Json | null)?.['assets'] ?? {}) as Record<string, Json | undefined>;
  return Object.entries(assets).filter((e): e is [string, Json] => e[1] !== undefined && typeof e[1] === 'object');
}

const sizeText = (n: number): string => (n >= 1024 * 1024 ? `${String(Math.floor(n / 1024 / 1024))} MB` : `${String(Math.floor(n / 1024))} KB`);

/** The raw body, up to the limit; a body too large is a 413 that says the limit, not a 500. */
function rawBody(limit: number): RequestHandler {
  const parse = express.raw({ type: () => true, limit });
  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      const type = (error as { type?: unknown }).type;
      if (type === 'entity.too.large') {
        next(new HttpError(413, `an upload may be at most ${sizeText(limit)}`));
        return;
      }
      next(new HttpError(400, 'the upload could not be read'));
    });
  };
}

export function assetRoutes(db: Db, store: AssetStore | null, maxBytes: number): Routes {
  const routes = new Routes(db);

  function storeOrRefuse(): AssetStore {
    if (store === null)
      throw new ProblemError({ status: 503, type: 'no-asset-store', title: 'this instance has no asset store', detail: 'Set ASSET_DIR to the asset volume (docs/self-host.md).' });
    return store;
  }

  /** Upload a texture image — or, with `?as=`, a model or a plan symbol — into a project. */
  routes.mutate(
    'POST',
    '/:projectId/assets',
    async (req, tx) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, 'send the image itself as the request body, not JSON');
      if (body.length === 0) throw new HttpError(400, 'the upload is empty');
      const purpose = purposeOf(req.query['as']);
      if (purpose === null) throw new HttpError(400, '`as` is texture, model or symbol');
      const assets = storeOrRefuse();
      let image;
      try {
        image = prepareUpload(new Uint8Array(body.buffer, body.byteOffset, body.length), purpose);
      } catch (error) {
        if (error instanceof MediaError) throw new HttpError(error.status, error.message);
        throw error;
      }
      // Written before the row: a file whose row then fails to commit is an unreferenced file, which
      // content addressing makes harmless; a row without its file would not be.
      const put = await assets.put(image.bytes);
      const name = cleanName(req.get('x-asset-name'));
      const row = await tx.projectAsset.upsert({
        where: { projectId_sha256: { projectId: project.id, sha256: put.sha256 } },
        update: {},
        create: {
          projectId: project.id,
          sha256: put.sha256,
          mediaType: image.mediaType,
          byteLength: put.byteLength,
          width: image.width,
          height: image.height,
          name,
          uploadedByAccountId: req.auth?.accountId ?? req.token?.accountId ?? null,
          uploadedByTokenId: req.auth === undefined ? (req.token?.tokenId ?? null) : null,
        },
      });
      const view = assetView(row);
      return {
        reply: (res) => res.status(201).location(view.href).json({ asset: view, stored: put.created ? 'new' : 'existing', stripped: image.stripped }),
        audit: {
          action: 'asset.upload',
          targetType: 'asset',
          targetId: put.sha256,
          detail: { projectId: project.id, purpose, mediaType: image.mediaType, byteLength: put.byteLength, created: put.created, stripped: image.stripped },
        },
      };
    },
    { token: 'propose', before: [rawBody(maxBytes)] },
  );

  /** The model's assets — each with whether its bytes are here — and the project's uploads. */
  routes.read(
    '/:projectId/assets',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const uploads = await db.projectAsset.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const readable = await readableDigests(project.id, project.ownerAccountId);
      const used = (await documentAssets(db, project.id)).map(([id, a]) => {
        const sha256 = typeof a['sha256'] === 'string' ? a['sha256'] : '';
        const ok = SHA256.test(sha256) && readable(sha256) && typeof a['path'] === 'string';
        return {
          id,
          path: typeof a['path'] === 'string' ? a['path'] : null,
          uri: typeof a['uri'] === 'string' ? a['uri'] : null,
          sha256,
          mediaType: a['mediaType'] ?? null,
          byteLength: a['byteLength'] ?? null,
          href: ok ? `/api/projects/${project.id}/assets/${sha256}` : null,
        };
      });
      res.setHeader('Cache-Control', 'private, no-cache');
      res.json({ assets: used, uploads: uploads.map(assetView) });
    },
    { token: 'read' },
  );

  /**
   * Which digests this project may read: its own uploads, and the digests its model names that its
   * owner uploaded into any project of theirs. Two queries, whatever the number of assets.
   */
  async function readableDigests(projectId: string, ownerAccountId: string): Promise<(sha256: string) => boolean> {
    const own = new Set((await db.projectAsset.findMany({ where: { projectId }, select: { sha256: true } })).map((r) => r.sha256));
    const named = (await documentAssets(db, projectId)).map(([, a]) => a['sha256']).filter((s): s is string => typeof s === 'string' && SHA256.test(s) && !own.has(s));
    if (named.length > 0) {
      const owners = await db.projectAsset.findMany({ where: { sha256: { in: named }, project: { ownerAccountId } }, select: { sha256: true } });
      for (const r of owners) own.add(r.sha256);
    }
    return (sha256) => own.has(sha256);
  }

  async function readable(req: Request, sha256: string): Promise<ProjectAsset | { sha256: string; mediaType: string } | null> {
    const project = req.project;
    if (project === undefined) return null;
    const mine = await db.projectAsset.findUnique({ where: { projectId_sha256: { projectId: project.id, sha256 } } });
    if (mine !== null) return mine;
    const named = (await documentAssets(db, project.id)).find(([, a]) => a['sha256'] === sha256);
    if (named === undefined) return null;
    const theirs = await db.projectAsset.findFirst({ where: { sha256, project: { ownerAccountId: project.ownerAccountId } } });
    return theirs;
  }

  /** A file's bytes, immutable: its URL is its digest, so it never changes. */
  routes.read(
    '/:projectId/assets/:sha256',
    async (req, res) => {
      const sha256 = String(req.params['sha256']);
      if (!SHA256.test(sha256)) throw new HttpError(404, 'asset not found');
      const row = await readable(req, sha256);
      if (row === null) throw new HttpError(404, 'asset not found');
      const assets = storeOrRefuse();
      const bytes = await assets.get(sha256);
      if (bytes === null) throw new HttpError(404, 'asset not found');
      const name = packagePath(sha256, row.mediaType).split('/').at(-1) ?? sha256;
      res.setHeader('Content-Type', row.mediaType);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('ETag', `"${sha256}"`);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Opened on its own, an image is shown and nothing in it runs.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Disposition', `${req.query['download'] === undefined ? 'inline' : 'attachment'}; filename="${name}"`);
      if (req.get('if-none-match') === `"${sha256}"`) {
        res.status(304).end();
        return;
      }
      res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    },
    { token: 'read' },
  );

  return routes;
}
