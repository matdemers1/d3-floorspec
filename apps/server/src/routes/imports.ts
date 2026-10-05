import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InvalidDocumentError } from '@floorspec/engine';
import {
  documentHashOf,
  IfcImportRefused,
  IfcWorkerUnavailable,
  reconcileIfc,
  type IfcEdit,
  type IfcReconciliation,
  type IfcReportEntry,
} from '@d3-floorspec/worker/ifc';
import type { Db, Tx } from '../db.js';
import { Prisma } from '../db.js';
import type { Changeset } from '../generated/prisma/client.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import type { Applier, Batch } from '../ops/applier.js';
import { MAIN } from '../domain/projects.js';
import { applyToHead, authorOf, changesetHead, lockProject, moveHead, retiredFor, runApplier } from '../domain/history.js';
import { changesetView, MAX_CHANGESET_NAME } from '../domain/changesets.js';
import { changesetEvent } from '../events/publish.js';
import { cleanName, rawBody } from './assets.js';

/**
 * The IFC round trip (FLR-T-9.5, FLR-REQ-132): an IFC file this project exported, edited in another
 * tool — the architect's — and uploaded back.
 *
 *   POST /api/projects/:projectId/imports/ifc     the .ifc file as the raw body; `X-File-Name` its
 *                                                 name, percent-encoded; `?base=<hash>` to name the
 *                                                 version it is based on instead of the one it says.
 *
 * The file names the version it came from in every element's `Floorspec_Identity.DocumentHash`; a
 * file that names none, or a version this project never had, is refused — "not exported from this
 * project" — unless the person names a base version. The Python IFC worker reconciles the file
 * against that version (synchronously: a house takes seconds, the person is waiting for the review,
 * and no transaction is held open meanwhile — the worker is called before the transaction starts).
 *
 * What it maps becomes **a proposed changeset, never main** (FLR-ADR-016), named
 * "IFC round-trip: <file name>", whose base is the version the file came from: accepting it
 * fast-forwards while main is still there and replays it onto main otherwise, like any proposal.
 * Each edit is applied whole or not at all: an edit the Ops applier refuses moves to the report as
 * `rejected`, with the applier's reason, and the rest still land. The report — every unmapped,
 * ambiguous or refused edit with its IFC GlobalId — is stored with the changeset, and the review
 * shows it beside the proposal. A file with nothing to import makes no changeset.
 */

/** The largest IFC file an import reads: base64 of it, and the payload, must fit the worker's 64 MB. */
export const MAX_IFC_BYTES = 40 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

interface Prepared {
  readonly name: string;
  readonly bytes: number;
  readonly base: { readonly hash: string; readonly seq: number | null; readonly chosen: boolean };
  readonly reconciliation: IfcReconciliation;
}

/** What `prepare` found, for the handler: kept beside the request, never on it. */
const prepared = new WeakMap<Request, Prepared>();

/** The report a changeset carries (`changesets.report`), as the review reads it. */
export interface ImportReport {
  readonly source: 'ifc';
  readonly file: { readonly name: string; readonly bytes: number; readonly schema: string | null; readonly originatingSystem: string | null };
  readonly base: string;
  readonly documentHash: string | null;
  readonly edits: readonly { readonly element: string; readonly kind: string; readonly changes: readonly string[]; readonly sources: IfcEdit['sources'] }[];
  readonly entries: readonly IfcReportEntry[];
  readonly counts: Readonly<Record<string, number>>;
}

function changesetName(file: string): string {
  const prefix = 'IFC round-trip: ';
  const room = MAX_CHANGESET_NAME - prefix.length - 6;
  return prefix + (file.length > room ? `${file.slice(0, room - 1)}…` : file);
}

/** The version the file came from, among this project's versions; its number on main and its time. */
async function originOf(db: Db, projectId: string, hash: string): Promise<{ hash: string; seq: number | null; at: Date; document: unknown } | null> {
  // A version this project reached by an op, or holds on a head (a project stored before an import).
  const reached =
    (await db.opLog.findFirst({ where: { projectId, OR: [{ afterHash: hash }, { beforeHash: hash }] }, select: { id: true } })) ??
    (await db.head.findFirst({ where: { projectId, versionHash: hash }, select: { name: true } }));
  if (reached === null) return null;
  const version = await db.version.findUnique({ where: { hash } });
  if (version === null) return null;
  const made = await db.opLog.findFirst({ where: { projectId, afterHash: hash, head: MAIN }, orderBy: { seq: 'asc' }, select: { seq: true, createdAt: true } });
  return { hash, seq: made?.seq ?? null, at: made?.createdAt ?? version.createdAt, document: version.document };
}

/**
 * Before the transaction: find the version, and have the IFC worker reconcile the file against it.
 * Everything that can be refused is refused here, before anything is written.
 */
function prepare(db: Db): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    (async () => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, 'send the .ifc file itself as the request body');
      if (body.length === 0) throw new HttpError(400, 'the upload is empty');
      const bytes = new Uint8Array(body.buffer, body.byteOffset, body.length);
      const name = cleanName(req.get('x-file-name')) ?? 'upload.ifc';
      const asked = req.query['base'];
      let hash: string;
      let chosen = false;
      if (typeof asked === 'string' && asked !== '') {
        if (!HASH.test(asked)) throw new HttpError(400, 'a base version is its 64-character hash');
        hash = asked;
        chosen = true;
      } else {
        const found = documentHashOf(bytes);
        if (found.hash === null) {
          throw new ProblemError({
            status: 422,
            type: 'not-a-floorspec-export',
            title: 'this IFC file was not exported from Floorspec',
            detail: 'Its elements carry no Floorspec identity, so there is nothing to reconcile them with. Only an IFC file exported from this project can be brought back.',
          });
        }
        hash = found.hash;
      }
      const origin = await originOf(db, project.id, hash);
      if (origin === null) {
        throw new ProblemError({
          status: 422,
          type: 'not-from-this-project',
          title: chosen ? 'that version is not one of this project’s' : 'this IFC file was not exported from this project',
          detail: chosen
            ? 'Choose a version from this project’s history.'
            : `It was exported from version ${hash.slice(0, 12)}, which this project never had. Import it into the project it came from, or choose the version it is based on.`,
          documentHash: chosen ? null : hash,
        });
      }
      let reconciliation: IfcReconciliation;
      try {
        reconciliation = await reconcileIfc(origin.document as object, bytes, {
          version: { hash: origin.hash, seq: origin.seq, at: origin.at },
          name,
          timeoutMs: Number(process.env['IFC_IMPORT_TIMEOUT_MS'] ?? 120_000),
        });
      } catch (error) {
        if (error instanceof IfcImportRefused) throw new ProblemError({ status: 422, type: 'ifc-not-read', title: 'the IFC file could not be read', detail: error.message });
        if (error instanceof IfcWorkerUnavailable) throw new ProblemError({ status: 503, type: 'ifc-worker-unavailable', title: 'the IFC worker is not answering', detail: error.message });
        if (error instanceof InvalidDocumentError) throw new ProblemError({ status: 422, type: 'not-drawable', title: 'the version this file came from is not valid', detail: 'Run validate on that version to see why.' });
        throw error;
      }
      prepared.set(req, { name, bytes: body.length, base: { hash: origin.hash, seq: origin.seq, chosen }, reconciliation });
    })().then(() => { next(); }, next);
  };
}

/**
 * Apply what applies. The whole batch first; when the applier refuses it, edit by edit, keeping each
 * that still commits on top of those kept before it — so one edit the applier refuses (an opening
 * widened past its wall's end) costs that edit, not the import.
 */
function applicable(applier: Applier, document: unknown, edits: readonly IfcEdit[], retired: readonly string[]) {
  const all = edits.flatMap((e) => e.ops) as unknown as Batch;
  if (all.length === 0) return { kept: [] as IfcEdit[], refused: [] as { edit: IfcEdit; reason: string }[] };
  if (runApplier(applier, document, all, retired).status === 'committed') return { kept: [...edits], refused: [] };
  const kept: IfcEdit[] = [];
  const refused: { edit: IfcEdit; reason: string }[] = [];
  for (const edit of edits) {
    const trial = [...kept, edit].flatMap((e) => e.ops) as unknown as Batch;
    const result = runApplier(applier, document, trial, retired);
    if (result.status === 'committed') kept.push(edit);
    else refused.push({ edit, reason: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ') || 'the applier refused it' });
  }
  return { kept, refused };
}

async function uniqueName(tx: Tx, projectId: string, wanted: string): Promise<string> {
  const taken = new Set((await tx.changeset.findMany({ where: { projectId, status: 'pending', name: { startsWith: wanted } }, select: { name: true } })).map((c) => c.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted} (${String(n)})`)) return `${wanted} (${String(n)})`;
}

export function importRoutes(db: Db, applier: Applier): Routes {
  const routes = new Routes(db);

  routes.mutate(
    'POST',
    '/:projectId/imports/ifc',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      const ready = prepared.get(req);
      if (project === undefined || ready === undefined) throw new HttpError(404, 'project not found');
      const { reconciliation: r, base, name } = ready;
      const author = authorOf(req);
      await lockProject(tx, project.id);
      const version = await tx.version.findUniqueOrThrow({ where: { hash: base.hash } });
      const retired = await retiredFor(tx, project.id);
      const { kept, refused } = applicable(applier, version.document, r.edits, retired);
      const entries: IfcReportEntry[] = [
        ...refused.map(({ edit, reason }) => ({
          severity: 'rejected' as const,
          globalId: edit.sources[0]?.globalId ?? null,
          entity: edit.sources[0]?.entity ?? null,
          element: edit.element,
          kind: edit.kind,
          name: null,
          change: edit.changes.join('; '),
          reason: `the Ops applier refused it — ${reason}`,
        })),
        ...r.report,
      ];
      const report: ImportReport = {
        source: 'ifc',
        file: { name, bytes: ready.bytes, schema: r.file.schema ?? null, originatingSystem: r.file.originatingSystem ?? null },
        base: base.hash,
        documentHash: r.documentHash,
        edits: kept.map((e) => ({ element: e.element, kind: e.kind, changes: e.changes, sources: e.sources })),
        entries,
        counts: { ...r.counts, edits: kept.length, rejected: refused.length },
      };
      const detail = { project: project.id, file: name, base: base.hash, chosen: base.chosen, edits: kept.length, rejected: refused.length, unmapped: r.counts['unmapped'] ?? 0, ambiguous: r.counts['ambiguous'] ?? 0 };

      if (kept.length === 0) {
        return {
          reply: (res) => res.status(200).json({ changeset: null, report }),
          audit: { action: 'import.ifc', targetType: 'project', targetId: project.id, detail: { ...detail, changeset: null } },
        };
      }

      let changeset: Changeset = await tx.changeset.create({
        data: {
          projectId: project.id,
          name: await uniqueName(tx, project.id, changesetName(name)),
          baseHash: base.hash,
          createdByAccountId: author.accountId,
          createdByTokenId: author.tokenId,
          createdByAgent: author.agent,
          report: report as unknown as Prisma.InputJsonObject,
        },
      });
      const head = changesetHead(changeset.id);
      await moveHead(tx, project.id, head, base.hash);
      const outcome = await applyToHead(tx, applier, {
        projectId: project.id,
        head,
        batch: kept.flatMap((e) => e.ops),
        author,
        kind: 'apply',
        changesetId: changeset.id,
      });
      if (outcome.status === 'rejected') throw new Error('the import batch was refused after it had been checked');
      changeset = await tx.changeset.findUniqueOrThrow({ where: { id: changeset.id } });
      return {
        reply: (res) =>
          res
            .status(201)
            .location(`/api/projects/${project.id}/changesets/${changeset.id}`)
            .json({ changeset: changesetView(changeset, { head: outcome.result.hash, ops: 1 }), report }),
        events: [changesetEvent(changeset, 'opened', { hash: outcome.result.hash, ops: 1 })],
        audit: { action: 'import.ifc', targetType: 'changeset', targetId: changeset.id, detail: { ...detail, changeset: changeset.id } },
      };
    },
    { token: 'propose', before: [rawBody(MAX_IFC_BYTES), prepare(db)] },
  );

  return routes;
}
