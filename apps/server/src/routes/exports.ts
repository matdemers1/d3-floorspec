import { evaluate } from '@floorspec/engine';
import type { Request } from 'express';
import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import type { Job } from '../generated/prisma/client.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';

/**
 * Drawing exports (FLR-T-9.3): a dimensioned PDF sheet per level, or DXF drawings on NCS-pattern
 * layers; the IFC4 Reference View model (FLR-T-9.4), written by the Python IFC worker; and the 3D
 * model (FLR-T-9.2) as glTF 2.0 binary or USDZ, in one design — the primary unless another is named —
 * which the job records. Asking for one queues a job on the Postgres job queue and answers 202; the worker drains
 * the queue, and the file is downloaded once the job is done. A job reads one immutable version —
 * main's head unless another version of this project is named — so its file is reproducible.
 */

const KINDS = ['pdf', 'dxf', 'ifc', 'gltf', 'usdz'] as const;
export const PAGE_NAMES = ['tabloid', 'arch-c', 'arch-d', 'letter', 'a4', 'a3'] as const;

const ExportBody = z.strictObject({
  kind: z.enum(KINDS),
  /** A version of this project, by hash. Default: main's head. */
  version: z.string().regex(/^[0-9a-f]{64}$/, 'a version is its 64-character hash').optional(),
  /** Level IDs; default every level. */
  levels: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
  /** PDF paper; default tabloid (17 × 11 in). */
  page: z.enum(PAGE_NAMES).optional(),
  /** glTF and USDZ: the design (Core 19.6), option set → option; default the primary design. */
  design: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).optional(),
});

/** How many exports a project may have waiting or running at once. */
export const MAX_PENDING = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A type, not an interface: Prisma's JSON input wants an index signature, which a type alias satisfies.
type Params = {
  readonly levels?: string[];
  readonly page?: string;
  readonly versionSeq?: number | null;
  readonly versionAt?: string;
  readonly design?: Record<string, string>;
};

/** A job as the API shows it: no worker internals, and where to get the file once there is one. */
export function exportView(projectId: string, job: Job) {
  const p = (job.params ?? {}) as Params;
  return {
    id: job.id,
    kind: job.kind.replace(/^export\./, ''),
    status: job.status,
    version: job.versionHash,
    versionSeq: p.versionSeq ?? null,
    levels: p.levels ?? null,
    page: job.kind === 'export.pdf' ? (p.page ?? 'tabloid') : null,
    design: p.design ?? null,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    download: job.status === 'done' ? `/api/projects/${projectId}/exports/${job.id}/file` : null,
  };
}

export function exportRoutes(db: Db): Routes {
  const routes = new Routes(db);

  async function jobOf(req: Request): Promise<Job> {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const id = String(req.params['jobId']);
    if (!UUID.test(id)) throw new HttpError(404, 'export not found');
    const job = await db.job.findFirst({ where: { id, projectId: project.id, kind: { startsWith: 'export.' } } });
    if (job === null) throw new HttpError(404, 'export not found');
    return job;
  }

  /** The version to draw and the facts its title block prints: its number on main and its time. */
  async function versionFor(tx: Tx, projectId: string, hash: string | undefined): Promise<{ hash: string; seq: number | null; at: Date; document: unknown }> {
    let target = hash;
    if (target === undefined) {
      const head = await tx.head.findUnique({ where: { projectId_name: { projectId, name: MAIN } } });
      if (head === null) throw new HttpError(404, 'this project has no model yet');
      target = head.versionHash;
    } else {
      const reached = await tx.opLog.findFirst({ where: { projectId, OR: [{ afterHash: target }, { beforeHash: target }] }, select: { id: true } });
      if (reached === null) throw new HttpError(404, 'version not found');
    }
    const version = await tx.version.findUniqueOrThrow({ where: { hash: target } });
    const made = await tx.opLog.findFirst({ where: { projectId, afterHash: target, head: MAIN }, orderBy: { seq: 'asc' }, select: { seq: true, createdAt: true } });
    return { hash: target, seq: made?.seq ?? null, at: made?.createdAt ?? version.createdAt, document: version.document };
  }

  /** Queue an export. */
  routes.mutate(
    'POST',
    '/:projectId/exports',
    async (req, tx) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const parsed = ExportBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new HttpError(400, 'the export request is not valid', { fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      const body = parsed.data;
      const version = await versionFor(tx, project.id, body.version);
      if (body.design !== undefined && body.kind !== 'gltf' && body.kind !== 'usdz') throw new HttpError(400, 'a design is chosen for a glTF or USDZ export');
      // Drawn only from geometry the engine can derive: an invalid model is refused now, not as a failed job.
      const ev = evaluate(version.document as object, body.design === undefined ? {} : { design: body.design });
      if (!ev.valid || ev.document === undefined)
        throw new ProblemError({ status: 422, type: 'not-drawable', title: 'this version cannot be drawn', detail: 'The model is not valid. Run validate to see why.' });
      if (body.design !== undefined && (ev.design === null || ev.view === undefined))
        throw new ProblemError({ status: 422, type: 'not-drawable', title: 'this design cannot be drawn', detail: 'The design names no design of this model, or that design is not valid.' });
      const levels = Object.keys(ev.document.levels ?? {});
      if (levels.length === 0) throw new ProblemError({ status: 422, type: 'not-drawable', title: 'this version has no levels to draw' });
      if (body.kind === 'ifc' && body.levels !== undefined) throw new HttpError(400, 'an IFC export is of the whole model: it takes no levels');
      const missing = (body.levels ?? []).filter((l) => !levels.includes(l));
      if (missing.length > 0) throw new HttpError(400, `the model has no level ${missing.join(', ')}`);
      const pending = await tx.job.count({ where: { projectId: project.id, kind: { startsWith: 'export.' }, status: { in: ['queued', 'running'] } } });
      if (pending >= MAX_PENDING) throw new HttpError(429, `this project already has ${String(pending)} exports waiting; try again when one finishes`);
      const params: Params = {
        ...(body.levels === undefined ? {} : { levels: [...new Set(body.levels)] }),
        ...(body.kind === 'pdf' ? { page: body.page ?? 'tabloid' } : {}),
        ...(body.design === undefined ? {} : { design: body.design }),
        versionSeq: version.seq,
        versionAt: version.at.toISOString(),
      };
      const job = await tx.job.create({
        data: {
          projectId: project.id,
          kind: `export.${body.kind}`,
          params: params,
          versionHash: version.hash,
          requestedByAccountId: req.auth?.accountId ?? req.token?.accountId ?? null,
          requestedByTokenId: req.auth === undefined ? (req.token?.tokenId ?? null) : null,
        },
      });
      return {
        reply: (res) => res.status(202).location(`/api/projects/${project.id}/exports/${job.id}`).json({ export: exportView(project.id, job) }),
        audit: { action: 'export.request', targetType: 'job', targetId: job.id, detail: { projectId: project.id, kind: body.kind, version: version.hash, levels: params.levels ?? null, page: params.page ?? null, ...(params.design === undefined ? {} : { design: params.design }) } },
      };
    },
    { token: 'read' },
  );

  /** This project's exports, newest first. */
  routes.read(
    '/:projectId/exports',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const jobs = await db.job.findMany({ where: { projectId: project.id, kind: { startsWith: 'export.' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 });
      res.json({ exports: jobs.map((j) => exportView(project.id, j)) });
    },
    { token: 'read' },
  );

  /** One export's state. */
  routes.read(
    '/:projectId/exports/:jobId',
    async (req, res) => {
      const job = await jobOf(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ export: exportView(job.projectId, job) });
    },
    { token: 'read' },
  );

  /** The file a finished export made. */
  routes.read(
    '/:projectId/exports/:jobId/file',
    async (req, res) => {
      const job = await jobOf(req);
      if (job.status === 'failed') throw new HttpError(409, `this export failed: ${job.error ?? 'no reason was recorded'}`);
      if (job.status !== 'done') throw new HttpError(409, 'this export is not finished yet');
      const output = await db.jobOutput.findUnique({ where: { jobId: job.id } });
      if (output === null) throw new HttpError(410, 'this export’s file has expired; export again');
      res.setHeader('Content-Type', output.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${output.name.replace(/[^\w.-]/g, '_')}"`);
      res.setHeader('ETag', `"${output.sha256}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(output.bytes));
    },
    { token: 'read' },
  );

  return routes;
}
