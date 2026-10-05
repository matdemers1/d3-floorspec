import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler } from 'express';
import { canonicalize, evaluate, OFFICIAL_READER, Package, type Diagnostic } from '@floorspec/engine';
import {
  DEFAULT_LIMITS,
  PACKAGE_EXTENSION,
  PACKAGE_MEDIA_TYPE,
  PackageError,
  documentToBatch,
  isZip,
  packageEntries,
  packageZip,
  packagedAssets,
  parseDocument,
  readPackage,
  type PackageLimits,
} from '@floorspec/package';
import type { Db, Tx } from '../db.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { createProject, MAIN } from '../domain/projects.js';
import { applyToHead, authorOf } from '../domain/history.js';
import { FLOORSPEC_VERSION } from '../model/document.js';
import type { Applier } from '../ops/applier.js';
import { SHA256, sha256Hex, type AssetStore } from '../assets/store.js';
import { EXTENSIONS, MediaError, prepareImage } from '../assets/media.js';
import { reachableFiles } from '../assets/access.js';
import { accountOf } from './auth.js';
import { cleanName, packagePath } from './assets.js';

/**
 * The `.floorspec` package (FLR-T-9.1, FLR-REQ-126, FLR-REQ-135, FLR-REQ-151; layout in
 * packages/package/README.md).
 *
 *   GET  /api/projects/:projectId/package[?version=<hash>]
 *        The project as a `.floorspec` ZIP: `model.json` (the version's canonical bytes, exactly as
 *        `model.json` serves them) and every asset's file at its path. Main's head, or any version
 *        this project has been at. **Always available, free:** a session or any token with `read`
 *        (read, write and agent tokens all have it), whatever the project's state — a pending
 *        changeset, an open share, a model that does not validate. An asset whose file this
 *        project cannot reach is left out and named in `X-Floorspec-Missing-Assets`: an export is
 *        never refused over a missing file. The same version and files give the same bytes; the
 *        ETag is their SHA-256.
 *
 *   POST /api/projects/import/floorspec
 *        A new project from a `.floorspec.json` document or a `.floorspec` package of Core 0.1, 0.2
 *        or 0.3 — the request body is the file's bytes, as it is. Validated by the engine (a
 *        package by the package validator, Core 18.4) as the official extensions' reader:
 *        **errors refuse the import** with the diagnostics (422, nothing stored), warnings and
 *        notes are kept and answered. The package's files are stored in the asset store and
 *        recorded as the project's assets; the project is created blank and the document applied
 *        as one batch of Floorspec Ops (FLR-ADR-008), so the import is the first edit in its
 *        history and the document keeps its declared Core version. A person's session only: a
 *        project is created by a person.
 */

/** A request body this large is refused before it is read. */
export const IMPORT_MAX_BYTES = 128 * 1024 * 1024;

const TEXTURE_TYPES = new Set(Object.keys(EXTENSIONS));

type Json = Record<string, unknown>;

/** The raw body, up to the limit; a body too large is a 413 that says the limit, not a 500. */
function rawBody(limit: number): RequestHandler {
  const parse = express.raw({ type: () => true, limit });
  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      if ((error as { type?: unknown }).type === 'entity.too.large') {
        next(new HttpError(413, `an import may be at most ${String(limit / 1024 / 1024)} MB`));
        return;
      }
      next(new HttpError(400, 'the file could not be read'));
    });
  };
}

/** The request body as bytes: raw, or — sent as JSON and parsed by the app already — re-serialised. */
function bodyBytes(req: Request): Uint8Array {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body.buffer, body.byteOffset, body.length);
  if (typeof body === 'object' && body !== null && Object.keys(body).length > 0) return new TextEncoder().encode(JSON.stringify(body));
  throw new HttpError(400, 'send the .floorspec.json or .floorspec file as the request body');
}

/** `Kitchen remodel` → `kitchen-remodel`, for a file name; never empty. */
export function fileStem(name: string): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80);
  return stem === '' ? 'model' : stem;
}

interface PreparedAsset {
  readonly asset: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly name: string | null;
}

export interface ImportReport {
  readonly source: 'document' | 'package';
  /** Warnings and notes the validator gave: kept, never a reason to refuse. */
  readonly diagnostics: Diagnostic[];
  /** Files stored for the project, by asset ID. */
  readonly stored: string[];
  /** Assets located by path whose file came with neither the import nor the owner's other projects. */
  readonly missing: string[];
  /** Files in the package nothing in the document names. */
  readonly ignored: string[];
  /** Textures whose metadata (EXIF, XMP, text chunks) was removed, as on upload: their digest changed. */
  readonly stripped: { asset: string; from: string; to: string; removed: string[] }[];
}

const notValid = (diagnostics: readonly Diagnostic[], source: string): ProblemError =>
  new ProblemError({
    status: 422,
    type: 'invalid-document',
    title: `the ${source} is not a valid Floorspec ${source === 'package' ? 'package' : 'document'}, so nothing was imported`,
    detail: diagnostics
      .filter((d) => d.severity === 'error')
      .slice(0, 20)
      .map((d) => `${d.code}: ${d.message}`)
      .join(' '),
    diagnostics,
  });

export function packageRoutes(db: Db, applier: Applier, store: AssetStore | null, maxAssetBytes: number): Routes {
  const routes = new Routes(db);
  const limits: PackageLimits = { ...DEFAULT_LIMITS, maxArchiveBytes: IMPORT_MAX_BYTES, maxEntryBytes: maxAssetBytes };

  /** The version to package: main's head, or one this project has been at (on main or a changeset). */
  async function versionOf(projectId: string, hash: unknown): Promise<{ hash: string; document: unknown }> {
    if (hash === undefined) {
      const head = await db.head.findUnique({ where: { projectId_name: { projectId, name: MAIN } }, include: { version: true } });
      if (head === null) throw new HttpError(404, 'this project has no model yet');
      return { hash: head.versionHash, document: head.version.document };
    }
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(404, 'version not found');
    const reached = await db.opLog.findFirst({ where: { projectId, OR: [{ afterHash: hash }, { beforeHash: hash }] }, select: { id: true } });
    if (reached === null) throw new HttpError(404, 'version not found');
    const version = await db.version.findUniqueOrThrow({ where: { hash } });
    return { hash, document: version.document };
  }

  routes.read(
    '/:projectId/package',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const version = await versionOf(project.id, req.query['version']);
      const reachable = await reachableFiles(db, project, version.document);
      const files = new Map<string, Uint8Array>();
      if (store !== null) {
        for (const a of packagedAssets(version.document)) {
          if (files.has(a.sha256) || !reachable.has(a.sha256)) continue;
          const bytes = await store.get(a.sha256);
          if (bytes !== null) files.set(a.sha256, bytes);
        }
      }
      const built = packageEntries(canonicalize(version.document), files);
      const zip = packageZip(built);
      const etag = `"${createHash('sha256').update(zip).digest('hex')}"`;
      const stem = fileStem(project.name);
      res.setHeader('Content-Type', PACKAGE_MEDIA_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${stem}${PACKAGE_EXTENSION}"; filename*=UTF-8''${encodeURIComponent(project.name.slice(0, 120))}${PACKAGE_EXTENSION}`);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Floorspec-Version', version.hash);
      if (built.missing.length > 0) res.setHeader('X-Floorspec-Missing-Assets', built.missing.map((m) => encodeURIComponent(m.asset)).join(','));
      if (req.get('if-none-match') === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Length', String(zip.length));
      res.send(Buffer.from(zip.buffer, zip.byteOffset, zip.length));
    },
    { token: 'read' },
  );

  /** The document and the files to store, checked; nothing is written here. */
  function prepare(bytes: Uint8Array): { document: Json; assets: PreparedAsset[]; report: Omit<ImportReport, 'missing'> & { missing: { asset: string; sha256: string }[] } } {
    const source = isZip(bytes) ? 'package' : 'document';
    let documentBytes = bytes;
    let files = new Map<string, Uint8Array>();
    let ignored: string[] = [];
    let missing: { asset: string; sha256: string }[];
    if (source === 'package') {
      try {
        const opened = readPackage(bytes, limits);
        documentBytes = opened.document;
        files = opened.files;
        ignored = opened.ignored;
        missing = opened.missing.map((m) => ({ asset: m.asset, sha256: m.sha256 }));
      } catch (error) {
        if (!(error instanceof PackageError)) throw error;
        throw new ProblemError({ status: error.code === 'too-large' || error.code === 'too-many-entries' ? 413 : 422, type: 'not-a-package', title: 'this is not a .floorspec package that can be imported', detail: error.message, code: error.code });
      }
    } else {
      if (bytes.length > limits.maxDocumentBytes) throw new HttpError(413, `a document may be at most ${String(limits.maxDocumentBytes / 1024 / 1024)} MB`);
      missing = packagedAssets(parseDocument(bytes)).map((m) => ({ asset: m.asset, sha256: m.sha256 }));
    }
    // The same engine as everywhere (FLR-ADR-010), as the reader of the official extensions; a
    // package validator when there is a package (Core 18.4).
    const evaluation = evaluate(documentBytes, { ...OFFICIAL_READER, ...(source === 'package' ? { package: new Package(files) } : {}) });
    if (!evaluation.valid) throw notValid(evaluation.diagnostics, source);
    const document = parseDocument(documentBytes);
    if (document === null) throw notValid(evaluation.diagnostics, source);

    // Each packaged file, checked as an upload is: a texture must be the image its media type says,
    // and loses its camera and location metadata — which changes its digest, so the document's
    // asset entry follows (and the batch that builds the project carries the new digest).
    const assets: PreparedAsset[] = [];
    const stripped: ImportReport['stripped'] = [];
    const entries = isObjectMap(document['assets']);
    for (const a of packagedAssets(document)) {
      const file = files.get(a.path);
      if (file === undefined) continue;
      const entry = entries[a.asset];
      const name = typeof entry?.['name'] === 'string' ? cleanName(encodeURIComponent(entry['name'])) : cleanName(encodeURIComponent(a.path));
      if (a.mediaType !== null && TEXTURE_TYPES.has(a.mediaType)) {
        let image;
        try {
          image = prepareImage(file);
        } catch (error) {
          if (error instanceof MediaError) throw new ProblemError({ status: 422, type: 'bad-asset', title: `asset ${a.asset} is not a usable texture`, detail: `${a.path}: ${error.message}`, asset: a.asset });
          throw error;
        }
        if (image.mediaType !== a.mediaType)
          throw new ProblemError({ status: 422, type: 'bad-asset', title: `asset ${a.asset} is not the image it says it is`, detail: `${a.path} says ${a.mediaType}, and its bytes are ${image.mediaType}`, asset: a.asset });
        let sha256 = a.sha256;
        if (image.stripped.length > 0 && entry !== undefined) {
          sha256 = sha256Hex(image.bytes);
          stripped.push({ asset: a.asset, from: a.sha256, to: sha256, removed: [...image.stripped] });
          entry['sha256'] = sha256;
          if (entry['byteLength'] !== undefined) entry['byteLength'] = image.bytes.length;
          if (entry['path'] === packagePath(a.sha256, a.mediaType)) entry['path'] = packagePath(sha256, a.mediaType);
        }
        assets.push({ asset: a.asset, sha256, bytes: image.bytes, mediaType: image.mediaType, width: image.width, height: image.height, name });
      } else {
        // Not a texture image (a furniture model, a symbol): kept as it came, its digest checked
        // by the package validator above, served with a sandbox CSP like every stored file.
        assets.push({ asset: a.asset, sha256: a.sha256, bytes: file, mediaType: a.mediaType ?? 'application/octet-stream', width: 0, height: 0, name });
      }
    }
    return {
      document,
      assets,
      report: { source, diagnostics: evaluation.diagnostics.filter((d) => d.severity !== 'error'), stored: assets.map((a) => a.asset), missing, ignored, stripped },
    };
  }

  routes.mutate(
    'POST',
    '/import/floorspec',
    async (req, tx: Tx): Promise<MutationResult> => {
      const accountId = accountOf(req);
      const bytes = bodyBytes(req);
      const { document, assets, report } = prepare(bytes);
      const project = isObjectMap({ p: document['project'] })['p'];
      const name = headerName(req.get('x-project-name')) ?? (typeof project?.['name'] === 'string' && project['name'].trim() !== '' ? project['name'].trim().slice(0, 200) : 'Imported house');

      if (assets.length > 0 && store === null)
        throw new ProblemError({ status: 503, type: 'no-asset-store', title: 'this instance has no asset store', detail: 'Set ASSET_DIR to the asset volume (docs/self-host.md), or import the model.json alone.' });
      // Files before rows, as an upload does: a file whose rows then fail to commit is an
      // unreferenced file, which content addressing makes harmless; a row without its file would not be.
      const stored = new Map<string, PreparedAsset>();
      for (const a of assets) {
        if (stored.has(a.sha256) || store === null) continue;
        const put = await store.put(a.bytes);
        if (put.sha256 !== a.sha256) throw new Error('the asset store keyed a file by another digest');
        stored.set(a.sha256, a);
      }

      const created = await createProject(tx, accountId, name);
      const batch = documentToBatch(document, name, { from: FLOORSPEC_VERSION });
      let head = created.hash;
      let seq = 1;
      if (batch.length > 0) {
        const outcome = await applyToHead(tx, applier, { projectId: created.project.id, head: MAIN, batch, author: authorOf(req), kind: 'apply' });
        if (outcome.status === 'rejected') {
          throw new ProblemError({
            status: 422,
            type: 'ops-rejected',
            title: 'the document could not be built as Floorspec Ops, so nothing was imported',
            detail: outcome.result.diagnostics.map((d) => `${d.code}: ${d.message}`).join(' '),
            diagnostics: outcome.result.diagnostics,
          });
        }
        head = outcome.op.afterHash;
        seq = outcome.op.seq;
      }
      if (stored.size > 0) {
        await tx.projectAsset.createMany({
          data: [...stored.values()].map((a) => ({
            projectId: created.project.id,
            sha256: a.sha256,
            mediaType: a.mediaType,
            byteLength: a.bytes.length,
            width: a.width,
            height: a.height,
            name: a.name,
            uploadedByAccountId: accountId,
          })),
          skipDuplicates: true,
        });
      }

      // Assets the import did not bring whose files the owner already has, in another project of
      // theirs, are reachable as they would be after copying a material (FLR-T-8.2): not missing.
      const reachable = await reachableFiles(tx, created.project, { assets: Object.fromEntries(report.missing.map((m) => [m.asset, { sha256: m.sha256 }])) });
      const missing = report.missing.filter((m) => !SHA256.test(m.sha256) || !reachable.has(m.sha256)).map((m) => m.asset);
      const answer: ImportReport = { ...report, missing };
      return {
        reply: (res) => res.status(201).location(`/api/projects/${created.project.id}`).json({ id: created.project.id, name, head, ...answer }),
        audit: {
          action: 'project.import',
          targetType: 'project',
          targetId: created.project.id,
          detail: {
            name,
            source: report.source,
            bytes: bytes.length,
            version: head,
            seq,
            ops: batch.length,
            assets: stored.size,
            missing,
            ignored: report.ignored.length,
            stripped: report.stripped.map((s) => s.asset),
            notes: report.diagnostics.length,
          },
        },
      };
    },
    { before: [rawBody(IMPORT_MAX_BYTES)] },
  );

  return routes;
}

/** A name sent in a header, percent-encoded: decoded, without control characters, at most 200 characters. */
function headerName(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    name = header;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name === '' ? null : name;
}

function isObjectMap(value: unknown): Record<string, Json | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : {};
}
