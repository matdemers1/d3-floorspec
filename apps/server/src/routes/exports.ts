import { createHash } from 'node:crypto';
import { evaluate, OFFICIAL_READER } from '@floorspec/engine';
import { LAYER_STATES, MODE_IDS, PLAN_LAYERS } from '@floorspec/render2d';
import { MAX_SHOTS, QUALITIES, SHOT_SIZES, shotWithinBudget, SIZES, SKIES, withinBudget, type Quality, type ShotSize, type Size } from '@d3-floorspec/worker/stills';
import { savedViewsOf } from '@floorspec/mesh';
import type { Request } from 'express';
import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import type { Job } from '../generated/prisma/client.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';
import { MediaError, prepareImage } from '../assets/media.js';
import { rawBody } from './assets.js';
import { MAX_PENDING_RENDERS } from './checks.js';

/**
 * Drawing exports (FLR-T-9.3): a dimensioned PDF sheet per level, or DXF drawings on NCS-pattern
 * layers; the IFC4 Reference View model (FLR-T-9.4), written by the Python IFC worker; and the 3D
 * model (FLR-T-9.2) as glTF 2.0 binary or USDZ. Drawings and 3D models are made in one design — the
 * primary unless another is named (FLR-T-9.7 for drawings) — which the job records; an IFC export
 * is of the primary design. Asking for one queues a job on the Postgres job queue and answers 202; the worker drains
 * the queue, and the file is downloaded once the job is done. A job reads one immutable version —
 * main's head unless another version of this project is named — so its file is reproducible.
 *
 * A path-traced still (FLR-T-12.6, FLR-REQ-154) is asked for the same way, `kind: "still"` with the
 * view, size and quality in `still`: the worker renders it offline, writing its passes to the job's
 * `progress` as it goes, and its PNG is downloaded like any export. One still renders at a time per
 * project, and a size and quality over the work budget are refused here, before anything is queued.
 *
 * A still path-traced in the editor on the viewer's own GPU (FLR-T-13.13, FLR-ADR-040) is saved to
 * the same list: `POST …/exports/stills` takes the PNG as the body and what it shows as the query —
 * the version it was rendered from (whose glTF export the editor traced), the view in words, the
 * samples — and records a finished `still` export with the file, so it is downloaded, listed and
 * kept like one the worker rendered. Nothing is queued: the browser did the work.
 */

const KINDS = ['pdf', 'dxf', 'ifc', 'gltf', 'usdz', 'still', 'shots'] as const;
const VIEWS = ['sw', 'se', 'ne', 'nw', 'top'] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A still's view, size and quality, and the sun (degrees, azimuth clockwise from true north). */
const StillBody = z.strictObject({
  camera: z.enum(VIEWS).optional(),
  /** Stand in this room (its ID or name) instead of a named view. */
  room: z.string().min(1).max(200).optional(),
  /** Cut away above this level. */
  level: z.string().regex(ID).optional(),
  size: z.enum(Object.keys(SIZES) as [Size, ...Size[]]).default('medium'),
  quality: z.enum(Object.keys(QUALITIES) as [Quality, ...Quality[]]).default('standard'),
  sun: z.strictObject({ azimuth: z.number().min(0).max(360), altitude: z.number().gt(0).max(90) }).optional(),
  /** The sky it is seen under (FLR-T-13.4): the 3D view's preset. */
  sky: z.enum(SKIES).optional(),
});
/**
 * A shot list (FLR-T-13.10): the saved views (FS_views) to render, by ID — default every one — at a
 * size by the long side and a quality, each traced as a still, one after another in one job.
 */
const ShotsBody = z.strictObject({
  views: z.array(z.string().regex(ID)).min(1).max(MAX_SHOTS).optional(),
  size: z.enum(Object.keys(SHOT_SIZES) as [ShotSize, ...ShotSize[]]).default('medium'),
  quality: z.enum(Object.keys(QUALITIES) as [Quality, ...Quality[]]).default('standard'),
});
export const PAGE_NAMES = ['tabloid', 'arch-c', 'arch-d', 'letter', 'a4', 'a3'] as const;

const ExportBody = z.strictObject({
  kind: z.enum(KINDS),
  /** A version of this project, by hash. Default: main's head. */
  version: z.string().regex(/^[0-9a-f]{64}$/, 'a version is its 64-character hash').optional(),
  /** Level IDs; default every level. */
  levels: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
  /** PDF paper; default tabloid (17 × 11 in). */
  page: z.enum(PAGE_NAMES).optional(),
  /** PDF, DXF, glTF and USDZ: the design (Core 19.6), option set → option; default the primary design. */
  design: z.record(z.string().regex(ID), z.string().regex(ID)).optional(),
  /** A still: what to render (FLR-T-12.6). */
  still: StillBody.optional(),
  /** PDF and DXF (FLR-T-18.3): a trade's view — an electrical plan, a furniture plan — and a person's own layer states over it. */
  mode: z.enum(MODE_IDS).optional(),
  layers: z.partialRecord(z.enum(PLAN_LAYERS), z.enum(LAYER_STATES)).optional(),
  /** A shot list: which saved views, how big and how clean (FLR-T-13.10). */
  shots: ShotsBody.optional(),
  /** glTF and USDZ: the doors closed (default) or open (FLR-T-13.8) — the editor's GPU still asks for either (FLR-T-13.13). */
  doors: z.enum(['open', 'closed']).optional(),
  /**
   * glTF and USDZ (FLR-T-13.12): the lights that are on — each by its ID, at an output (1–100 % of
   * full) and a colour temperature (kelvin) — every other off: the editor's lighting, which its GPU
   * still traces. Default every light at full.
   */
  lighting: z
    .strictObject({ on: z.record(z.string().regex(ID), z.strictObject({ output: z.int().min(1).max(100).optional(), cct: z.int().min(1000).max(10000).optional() })) })
    .refine((l) => Object.keys(l.on).length <= 2000, 'at most 2000 lights')
    .optional(),
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
  readonly mode?: string;
  readonly layers?: Record<string, string>;
  readonly doors?: 'open' | 'closed';
  readonly lighting?: { on: Record<string, { output?: number; cct?: number }> };
  readonly camera?: string;
  readonly room?: string;
  readonly level?: string;
  readonly size?: string;
  readonly quality?: string;
  readonly sun?: { azimuth: number; altitude: number };
  /** A still: `server` (the worker's CPU tracer) unless the editor rendered it on its GPU (FLR-T-13.13). */
  readonly source?: 'server' | 'gpu';
  /** A GPU still: the view in words, how it was lit, its samples and the device. */
  readonly view?: string;
  readonly lights?: 'on' | 'off';
  readonly scene?: string;
  readonly time?: 'day' | 'dusk' | 'night';
  readonly sky?: string;
  readonly samples?: number;
  readonly device?: string;
  /** A shot list: the saved views asked for, by ID (absent: every one). */
  readonly views?: string[];
};

/** The largest still the editor may save: a 4K PNG with room to spare. */
export const STILL_MAX_BYTES = 64 * 1024 * 1024;
/** The widest and tallest a saved still may be, pixels: the editor's largest size is 4K (3840 × 2160). */
export const STILL_MAX_SIDE = 4096;

/** What a GPU still shows, as the query of its upload. */
const StillUpload = z.strictObject({
  /** The version rendered: its 64-character hash. */
  version: z.string().regex(/^[0-9a-f]{64}$/, 'a version is its 64-character hash'),
  /** The view, in words: "SW iso", "Kitchen (R3) from its doorway D2", "The view in the editor". */
  view: z.string().trim().min(1).max(200),
  /** Samples a pixel. */
  samples: z.coerce.number().int().min(1).max(1 << 16),
  /** How long it took, ms. */
  ms: z.coerce.number().int().min(0).max(7 * 24 * 3600 * 1000).optional(),
  lights: z.enum(['on', 'off']).optional(),
  /** The lighting scene it was lit by (FLR-T-13.12), by name: "Evening", or "Evening (changed)". */
  scene: z.string().trim().min(1).max(200).optional(),
  time: z.enum(['day', 'dusk', 'night']).optional(),
  /** The sky it was seen under (FLR-T-13.4). */
  sky: z.enum(SKIES).optional(),
  /** The GPU it was traced on, as the browser names it: GPU stills are repeatable per machine, not across machines. */
  device: z.string().trim().max(200).optional(),
  /** The design (Core 19.6), as JSON: option set → option. */
  design: z.string().max(4000).optional(),
});
const Design = z.record(z.string().regex(ID), z.string().regex(ID));

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
    mode: p.mode ?? null,
    still:
      job.kind === 'export.still'
        ? {
            source: p.source ?? 'server',
            camera: p.camera ?? null,
            room: p.room ?? null,
            level: p.level ?? null,
            size: p.size ?? (p.source === 'gpu' ? null : 'medium'),
            quality: p.quality ?? (p.source === 'gpu' ? null : 'standard'),
            sun: p.sun ?? null,
            sky: p.sky ?? null,
            ...(p.source === 'gpu' ? { view: p.view ?? null, samples: p.samples ?? null, lights: p.lights ?? null, scene: p.scene ?? null, time: p.time ?? null, device: p.device ?? null } : {}),
          }
        : null,
    shots: job.kind === 'export.shots' ? { views: p.views ?? null, size: p.size ?? 'medium', quality: p.quality ?? 'standard' } : null,
    progress: job.status === 'running' ? (job.progress ?? null) : null,
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
      if (body.design !== undefined && body.kind === 'ifc') throw new HttpError(400, 'a design is chosen for a drawing or a 3D model, not an IFC export');
      // Drawn only from geometry the engine can derive: an invalid model is refused now, not as a failed job.
      // Checked with the reader the worker makes every kind with — the one the api and the editor read
      // with everywhere (OFFICIAL_READER; FLR-T-12.8 drawings, FLR-T-12.10 the rest): a model that
      // requires an official extension is exported in every kind, one the editor calls invalid in none.
      const ev = evaluate(version.document as object, body.design === undefined ? OFFICIAL_READER : { ...OFFICIAL_READER, design: body.design });
      if (!ev.valid || ev.document === undefined)
        throw new ProblemError({ status: 422, type: 'not-drawable', title: 'this version cannot be drawn', detail: 'The model is not valid. Run validate to see why.' });
      if (body.design !== undefined && (ev.design === null || ev.view === undefined))
        throw new ProblemError({ status: 422, type: 'not-drawable', title: 'this design cannot be drawn', detail: 'The design names no design of this model, or that design is not valid.' });
      const levels = Object.keys(ev.document.levels ?? {});
      if (levels.length === 0) throw new ProblemError({ status: 422, type: 'not-drawable', title: 'this version has no levels to draw' });
      if (body.kind === 'ifc' && body.levels !== undefined) throw new HttpError(400, 'an IFC export is of the whole model: it takes no levels');
      if (body.still !== undefined && body.kind !== 'still') throw new HttpError(400, 'only a still takes still options');
      if (body.shots !== undefined && body.kind !== 'shots') throw new HttpError(400, 'only a shot list takes shots options');
      if (body.doors !== undefined && body.kind !== 'gltf' && body.kind !== 'usdz') throw new HttpError(400, 'only a glTF or USDZ model takes doors');
      if (body.lighting !== undefined && body.kind !== 'gltf' && body.kind !== 'usdz') throw new HttpError(400, 'only a glTF or USDZ model takes a lighting');
      if ((body.mode !== undefined || body.layers !== undefined) && body.kind !== 'pdf' && body.kind !== 'dxf') throw new HttpError(400, 'a mode is a view of the plan: only a PDF or DXF drawing takes one');
      const still = body.kind === 'still' ? StillBody.parse(body.still ?? {}) : undefined;
      if (still !== undefined) {
        if (body.levels !== undefined || body.page !== undefined) throw new HttpError(400, 'a still takes a view, a size and a quality, not levels or a page');
        if (still.room !== undefined && still.camera !== undefined) throw new HttpError(400, 'a still is from a named view or from a room, not both');
        if (!withinBudget(still.size, still.quality)) throw new HttpError(400, `a ${still.size} still at ${still.quality} quality is more work than a still may take: choose a smaller size or a lower quality`);
        const view = ev.view ?? ev.document;
        if (still.level !== undefined && !Object.hasOwn(view.levels ?? {}, still.level)) throw new HttpError(400, `the model has no level ${still.level}`);
        if (still.room !== undefined) {
          const key = still.room.toLowerCase();
          const known = Object.entries(view.rooms ?? {}).some(([rid, r]) => rid.toLowerCase() === key || r?.name?.toLowerCase() === key);
          if (!known) throw new HttpError(400, `the model has no room ${still.room}`);
        }
        const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: ['export.still', 'export.shots'] }, status: { in: ['queued', 'running'] } } });
        if (rendering > 0) throw new HttpError(429, 'a still or a shot list is already rendering for this project; wait for it to finish');
      }
      const shots = body.kind === 'shots' ? ShotsBody.parse(body.shots ?? {}) : undefined;
      if (shots !== undefined) {
        if (body.levels !== undefined || body.page !== undefined) throw new HttpError(400, 'a shot list renders the saved views as they are: it takes no levels or page');
        if (!shotWithinBudget(shots.size, shots.quality)) throw new HttpError(400, `a ${shots.size} shot at ${shots.quality} quality is more work than a still may take: choose a smaller size or a lower quality`);
        const saved = savedViewsOf(ev.document);
        if (saved.length === 0) throw new ProblemError({ status: 422, type: 'no-saved-views', title: 'this model has no saved views', detail: 'Save a view in the 3D view, or add one with setProperty of $document (FS_views), then render the shot list.' });
        const unknown = (shots.views ?? []).filter((v) => !saved.some((s) => s.id === v));
        if (unknown.length > 0) throw new HttpError(400, `the model has no saved view ${unknown.join(', ')}; its views are ${saved.map((v) => v.id).join(', ')}`);
        if ((shots.views ?? saved).length > MAX_SHOTS) throw new HttpError(400, `a shot list renders at most ${String(MAX_SHOTS)} views`);
        // One shot list at a time, and it takes one of the project's three render places (FLR-T-8.5).
        const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: ['export.shots', 'export.still'] }, status: { in: ['queued', 'running'] } } });
        if (rendering > 0) throw new HttpError(429, 'a shot list or a still is already rendering for this project; wait for it to finish');
        const renders = await tx.job.count({ where: { projectId: project.id, kind: 'render.3d', status: { in: ['queued', 'running'] } } });
        if (renders >= MAX_PENDING_RENDERS) throw new HttpError(429, `this project already has ${String(renders)} 3D renders waiting; try again when one finishes`);
      }
      const missing = (body.levels ?? []).filter((l) => !levels.includes(l));
      if (missing.length > 0) throw new HttpError(400, `the model has no level ${missing.join(', ')}`);
      const pending = await tx.job.count({ where: { projectId: project.id, kind: { startsWith: 'export.' }, status: { in: ['queued', 'running'] } } });
      if (pending >= MAX_PENDING) throw new HttpError(429, `this project already has ${String(pending)} exports waiting; try again when one finishes`);
      const params: Params = {
        ...(body.levels === undefined ? {} : { levels: [...new Set(body.levels)] }),
        ...(body.kind === 'pdf' ? { page: body.page ?? 'tabloid' } : {}),
        ...(body.design === undefined ? {} : { design: body.design }),
        ...(body.mode === undefined ? {} : { mode: body.mode }),
        ...(body.layers === undefined ? {} : { layers: { ...body.layers } }),
        ...(body.doors === undefined ? {} : { doors: body.doors }),
        ...(body.lighting === undefined ? {} : { lighting: { on: Object.fromEntries(Object.entries(body.lighting.on).map(([id, s]) => [id, { ...(s.output === undefined ? {} : { output: s.output }), ...(s.cct === undefined ? {} : { cct: s.cct }) }])) } }),
        ...(shots === undefined ? {} : { ...(shots.views === undefined ? {} : { views: [...new Set(shots.views)] }), size: shots.size, quality: shots.quality }),
        ...(still === undefined
          ? {}
          : {
              ...(still.camera === undefined ? {} : { camera: still.camera }),
              ...(still.room === undefined ? {} : { room: still.room }),
              ...(still.level === undefined ? {} : { level: still.level }),
              size: still.size,
              quality: still.quality,
              ...(still.sun === undefined ? {} : { sun: still.sun }),
              ...(still.sky === undefined ? {} : { sky: still.sky }),
            }),
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
        audit: { action: 'export.request', targetType: 'job', targetId: job.id, detail: { projectId: project.id, kind: body.kind, version: version.hash, levels: params.levels ?? null, page: params.page ?? null, ...(params.design === undefined ? {} : { design: params.design }), ...(params.mode === undefined ? {} : { mode: params.mode }), ...(params.doors === undefined ? {} : { doors: params.doors }), ...(still === undefined ? {} : { still: { camera: params.camera ?? null, room: params.room ?? null, level: params.level ?? null, size: params.size, quality: params.quality } }), ...(shots === undefined ? {} : { shots: { views: params.views ?? null, size: params.size, quality: params.quality } }) } },
      };
    },
    { token: 'read' },
  );

  /**
   * Save a still the editor path-traced on the viewer's GPU (FLR-T-13.13): the PNG as the body, what
   * it shows as the query. Recorded as a finished still of that version, with its file.
   */
  routes.mutate(
    'POST',
    '/:projectId/exports/stills',
    async (req, tx) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const parsed = StillUpload.safeParse(req.query);
      if (!parsed.success) throw new HttpError(400, 'the still’s description is not valid', { fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      const meta = parsed.data;
      let design: Record<string, string> | undefined;
      if (meta.design !== undefined) {
        let raw: unknown;
        try {
          raw = JSON.parse(meta.design);
        } catch {
          throw new HttpError(400, 'design is JSON: option set → option');
        }
        const d = Design.safeParse(raw);
        if (!d.success) throw new HttpError(400, 'design is JSON: option set → option');
        design = d.data;
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, 'send the PNG itself as the request body');
      if (body.length === 0) throw new HttpError(400, 'the still is empty');
      let image;
      try {
        image = prepareImage(new Uint8Array(body.buffer, body.byteOffset, body.length));
      } catch (error) {
        if (error instanceof MediaError) throw new HttpError(error.status, error.message);
        throw error;
      }
      if (image.mediaType !== 'image/png') throw new HttpError(415, 'a still is a PNG image');
      if (image.width > STILL_MAX_SIDE || image.height > STILL_MAX_SIDE) throw new HttpError(422, `this still is ${String(image.width)} × ${String(image.height)} px; a still may be at most ${String(STILL_MAX_SIDE)} px on a side`);
      // The version the editor traced: main's head when it asked for the glTF, or one this project reached.
      const head = await tx.head.findUnique({ where: { projectId_name: { projectId: project.id, name: MAIN } } });
      const version = await versionFor(tx, project.id, head?.versionHash === meta.version ? undefined : meta.version);
      const bytes = new Uint8Array(image.bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const slug = meta.view.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'view';
      const name = `still-gpu-${slug}-${version.hash.slice(0, 8)}.png`;
      const params: Params = {
        source: 'gpu',
        view: meta.view,
        samples: meta.samples,
        ...(meta.lights === undefined ? {} : { lights: meta.lights }),
        ...(meta.scene === undefined ? {} : { scene: meta.scene }),
        ...(meta.time === undefined ? {} : { time: meta.time }),
        ...(meta.device === undefined || meta.device === '' ? {} : { device: meta.device }),
        ...(design === undefined ? {} : { design }),
        versionSeq: version.seq,
        versionAt: version.at.toISOString(),
      };
      const result = {
        name,
        contentType: 'image/png',
        size: bytes.byteLength,
        sha256,
        label: 'Path-traced on your GPU — repeatable on this device, not across devices',
        source: 'gpu',
        width: image.width,
        height: image.height,
        samples: meta.samples,
        camera: meta.view,
        ...(meta.ms === undefined ? {} : { ms: meta.ms }),
        ...(meta.lights === undefined ? {} : { lights: meta.lights }),
        ...(meta.scene === undefined ? {} : { scene: meta.scene }),
        ...(meta.time === undefined ? {} : { time: meta.time }),
        ...(meta.device === undefined || meta.device === '' ? {} : { device: meta.device }),
        design: design ?? null,
      };
      const now = new Date();
      const job = await tx.job.create({
        data: {
          projectId: project.id,
          kind: 'export.still',
          status: 'done',
          params,
          result,
          versionHash: version.hash,
          startedAt: now,
          finishedAt: now,
          requestedByAccountId: req.auth?.accountId ?? req.token?.accountId ?? null,
          requestedByTokenId: req.auth === undefined ? (req.token?.tokenId ?? null) : null,
          output: { create: { name, contentType: 'image/png', bytes, sha256 } },
        },
      });
      return {
        reply: (res) => res.status(201).location(`/api/projects/${project.id}/exports/${job.id}`).json({ export: exportView(project.id, job) }),
        audit: { action: 'export.upload', targetType: 'job', targetId: job.id, detail: { projectId: project.id, kind: 'still', source: 'gpu', version: version.hash, view: meta.view, width: image.width, height: image.height, samples: meta.samples, size: bytes.byteLength, sha256 } },
      };
    },
    { token: 'propose', before: [rawBody(STILL_MAX_BYTES)] },
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
