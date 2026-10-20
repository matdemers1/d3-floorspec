import { createHash } from 'node:crypto';
import { evaluate, OFFICIAL_READER } from '@floorspec/engine';
import { LAYER_STATES, MODE_IDS, PLAN_LAYERS, PLAN_STYLES, RENOVATION_FILTERS } from '@floorspec/render2d';
import { MAX_SHOTS, QUALITIES, SHOT_SIZES, shotWithinBudget, SIZES, SKIES, withinBudget, type Quality, type ShotSize, type Size } from '@d3-floorspec/worker/stills';
import { DEFAULT_EYE_HEIGHT, filmDuration, filmFrameCount, filmNamed, filmProblem, filmShots, filmsOf, MAX_EYE_HEIGHT, MAX_TOUR_ROOMS, MIN_EYE_HEIGHT, readView, savedViewNamed, savedViewsOf, TOUR_QUALITIES, TOUR_SIZES, tourAt, tourRoomsByDefault, tourWithinBudget, type TourQuality, type TourSize } from '@floorspec/mesh';
import { storeZip } from '@d3-floorspec/worker/zip';
import { midsummer, timelapseAround, timelapseProblem } from '@floorspec/mesh/sky';
import { FILM_FORMATS, FILM_LIGHTS, FILM_QUALITIES, FILM_RATES, FILM_SIZES, filmChoiceProblem, finalSamples, type FilmSize } from '@d3-floorspec/worker/films';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import type { Job } from '../generated/prisma/client.js';
import { Prisma } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';
import { changesetHead } from '../domain/history.js';
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
 *
 * A film (FLR-T-14.1, FLR-ADR-051) is asked for as `kind: "film"` with the film — one the document
 * keeps in its extras, by ID or name — and its quality, size, frame rate, container and light in
 * `film`: a day-to-night timelapse is given its day and clocks here, two hours before the site's
 * sunset to an hour after unless the request says otherwise. It renders on the worker as a still
 * does, one at a time per project, reporting its frames. Any export still queued or running can be
 * cancelled (`POST …/exports/:jobId/cancel`): the worker stops at its next report.
 *
 * A matched pair (FLR-T-14.4, FLR-ADR-054) is `kind: "pair"`: two sides — A (main's head unless
 * another is named) and B, each a pending changeset, a version or main, in a design — path-traced
 * from one camera (a saved view, a named view, or `shot`: a view as FS_views records one — the
 * editor's camera as it is) into a ZIP of the two pictures and their swipe and side-by-side
 * composites. The job reads A's version; B's version and design travel in its parameters. It takes
 * a render place as a shot list does: one still, shot list, film or pair renders at a time.
 *
 * A virtual tour (FLR-T-14.2, FLR-ADR-057) is `kind: "tour"`: the rooms in its order (the first opens
 * it; default every room but garages, closets and the outdoors), each seen from its centre or a saved
 * view's eye, at an eye height, a panorama size and a quality — each panorama within a still's work
 * budget. It takes a render place as a film does. Its file is the tour's manifest, and its panoramas
 * and plans are kept beside it as the job's assets; the download is a ZIP of them all. A share link
 * shows it (share/routes.ts), and keeps its files for as long as the link lives.
 *
 * A USDZ is tuned for AR Quick Look (FLR-T-14.3): `ar` asks for true scale (on the lot, the default)
 * or a table's 1:50, and what it includes besides its levels — roofs, furniture, fixtures and lights
 * (on unless said otherwise) and the lawn and site (off unless asked for). Its file is served inline
 * when asked (`?inline=1`), so an iPhone's or iPad's `<a rel="ar">` opens it in AR Quick Look; a link
 * of its own (share/routes.ts) sends it to a phone.
 */

const KINDS = ['pdf', 'dxf', 'ifc', 'gltf', 'usdz', 'still', 'shots', 'film', 'pair', 'tour'] as const;
/** The kinds that render on the worker for a while: one at a time per project. */
const RENDERING = ['export.still', 'export.shots', 'export.film', 'export.pair', 'export.tour'];
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
/**
 * A film (FLR-T-14.1): which of the document's films — by ID or name, default the first — drawn as a
 * draft or path-traced as a final, at a size and frame rate, as MP4 or WebM, in the light of its
 * keyframes or day to night.
 */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const FilmBody = z.strictObject({
  film: z.string().trim().min(1).max(200).optional(),
  quality: z.enum(FILM_QUALITIES).default('draft'),
  format: z.enum(FILM_FORMATS).default('mp4'),
  size: z.enum(Object.keys(FILM_SIZES) as [FilmSize, ...FilmSize[]]).default('1080p'),
  fps: z.union(FILM_RATES.map((r) => z.literal(r)) as unknown as [z.ZodLiteral<24>, z.ZodLiteral<30>, z.ZodLiteral<60>]).default(30),
  light: z.enum(FILM_LIGHTS).default('timeline'),
  /** Day to night: the day and the clocks at the site; what is left out is the preset's. */
  timelapse: z
    .strictObject({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD').optional(),
      from: z.string().regex(CLOCK, 'a time is HH:MM').optional(),
      to: z.string().regex(CLOCK, 'a time is HH:MM').optional(),
      lightsAtDusk: z.boolean().optional(),
    })
    .optional(),
});
const HASH = /^[0-9a-f]{64}$/;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A side of a matched pair (FLR-T-14.4): main's head, a pending changeset or a version — in a design. */
const PairSide = z
  .strictObject({
    changeset: z.string().regex(UUID_ID, 'a changeset is its ID').optional(),
    version: z.string().regex(HASH, 'a version is its 64-character hash').optional(),
    design: z.record(z.string().regex(ID), z.string().regex(ID)).optional(),
  })
  .refine((s) => s.changeset === undefined || s.version === undefined, 'a side is a changeset or a version, not both');
/**
 * A matched pair (FLR-T-14.4): A (default main's head) and B, from one camera — a saved view by ID or
 * name, a named view, or `shot`, a view as FS_views records one — at a shot list's size and quality.
 */
const PairBody = z.strictObject({
  a: PairSide.optional(),
  b: PairSide,
  view: z.string().trim().min(1).max(200).optional(),
  camera: z.enum(VIEWS).optional(),
  shot: z.record(z.string(), z.unknown()).optional(),
  size: z.enum(Object.keys(SHOT_SIZES) as [ShotSize, ...ShotSize[]]).default('small'),
  quality: z.enum(Object.keys(QUALITIES) as [Quality, ...Quality[]]).default('draft'),
});
/**
 * A virtual tour (FLR-T-14.2): the rooms, in order — each by its ID or name, seen from its centre or
 * a saved view's eye (by ID or name) — default every room but garages, closets and the outdoors; the
 * eye's height above each floor in base units; the panoramas' width and quality.
 */
const TourBody = z.strictObject({
  rooms: z.array(z.strictObject({ room: z.string().trim().min(1).max(200), view: z.string().trim().min(1).max(200).optional() })).min(1).max(MAX_TOUR_ROOMS).optional(),
  eyeHeight: z.int().min(MIN_EYE_HEIGHT).max(MAX_EYE_HEIGHT).default(DEFAULT_EYE_HEIGHT),
  size: z.enum(Object.keys(TOUR_SIZES) as [TourSize, ...TourSize[]]).default('large'),
  quality: z.enum(Object.keys(TOUR_QUALITIES) as [TourQuality, ...TourQuality[]]).default('standard'),
});
export const PAGE_NAMES = ['tabloid', 'arch-c', 'arch-d', 'letter', 'a4', 'a3'] as const;

/** A USDZ for AR Quick Look (FLR-T-14.3): its scale, and what it includes besides its levels. */
const ArBody = z.strictObject({
  scale: z.enum(['true', 'table']).default('true'),
  roofs: z.boolean().optional(),
  furniture: z.boolean().optional(),
  fixtures: z.boolean().optional(),
  site: z.boolean().optional(),
});

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
  /** PDF (FLR-T-18.5): the plan's style — a colour sheet, a technical one, a blueprint. */
  style: z.enum(PLAN_STYLES).optional(),
  /** PDF and DXF (FLR-T-18.13): a remodel's renovation plan — Existing, Demolition, Proposed or Combined. */
  renovation: z.enum(RENOVATION_FILTERS).optional(),
  /** A shot list: which saved views, how big and how clean (FLR-T-13.10). */
  shots: ShotsBody.optional(),
  /** A film: which, how, and in what light (FLR-T-14.1). */
  film: FilmBody.optional(),
  /** A matched pair: its two sides, its camera, how big and how clean (FLR-T-14.4). */
  pair: z.unknown().optional(),
  /** A virtual tour: its rooms, the eye height, how big and how clean (FLR-T-14.2). */
  tour: TourBody.optional(),
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
  /** USDZ (FLR-T-14.3): for AR Quick Look — true scale or 1:50, and what it includes. */
  ar: ArBody.optional(),
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
  readonly style?: string;
  readonly renovation?: string;
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
  /** A film (FLR-T-14.1): its ID and name, and how it is made. */
  readonly film?: string;
  readonly filmName?: string;
  readonly format?: string;
  readonly fps?: number;
  readonly frames?: number;
  readonly light?: string;
  readonly timelapse?: { date: string; from: string; to: string; lightsAtDusk: boolean };
  /** A matched pair (FLR-T-14.4): what A is, in words; B's version, design and words; the camera given whole. */
  readonly aLabel?: string;
  readonly pair?: { hash: string; seq: number | null; label: string; design?: Record<string, string> };
  readonly shot?: Prisma.InputJsonObject;
  /** A virtual tour (FLR-T-14.2): the rooms in order (IDs), each with the saved view it is seen from; the eye height; the light. */
  readonly rooms?: { room: string; name: string; view?: string }[];
  readonly eyeHeight?: number;
  readonly at?: string;
  /** A USDZ for AR Quick Look (FLR-T-14.3). */
  readonly ar?: { scale: 'true' | 'table'; roofs?: boolean; furniture?: boolean; fixtures?: boolean; site?: boolean };
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
    style: p.style ?? null,
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
    pair:
      job.kind === 'export.pair'
        ? {
            a: { label: p.aLabel ?? null, version: job.versionHash, design: p.design ?? null },
            b: { label: p.pair?.label ?? null, version: p.pair?.hash ?? null, design: p.pair?.design ?? null },
            view: p.view ?? null,
            camera: p.camera ?? null,
            shot: p.shot !== undefined,
            size: p.size ?? 'small',
            quality: p.quality ?? 'draft',
          }
        : null,
    tour:
      job.kind === 'export.tour'
        ? { rooms: (p.rooms ?? []).map((r) => ({ id: r.room, name: r.name, view: r.view ?? null })), panos: p.rooms?.length ?? 0, size: p.size ?? 'large', quality: p.quality ?? 'standard', eyeHeight: p.eyeHeight ?? DEFAULT_EYE_HEIGHT, at: p.at ?? null }
        : null,
    film:
      job.kind === 'export.film'
        ? { id: p.film ?? null, name: p.filmName ?? p.film ?? null, quality: p.quality ?? 'draft', format: p.format ?? 'mp4', size: p.size ?? '1080p', fps: p.fps ?? 30, frames: p.frames ?? null, light: p.light ?? 'timeline', timelapse: p.timelapse ?? null, ...(p.samples === undefined ? {} : { samples: p.samples }) }
        : null,
    /** A USDZ for AR Quick Look (FLR-T-14.3): its scale and what it includes; true scale, all but the site, when not asked. */
    ar: job.kind === 'export.usdz' ? { scale: p.ar?.scale ?? 'true', roofs: p.ar?.roofs ?? true, furniture: p.ar?.furniture ?? true, fixtures: p.ar?.fixtures ?? true, site: p.ar?.site ?? false } : null,
    /** Stopped by a person (FLR-T-14.1) rather than failed. */
    cancelled: job.status === 'failed' && (job.result as { cancelled?: unknown } | null)?.cancelled === true,
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

  /** "Kitchen · Option B": a design in the words its document gives it. */
  function designWords(document: unknown, design: Record<string, string>): string {
    const d = (document ?? {}) as { optionSets?: Record<string, { name?: string } | undefined>; options?: Record<string, { name?: string } | undefined> };
    return Object.entries(design)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([set, option]) => `${d.optionSets?.[set]?.name ?? set} · ${d.options?.[option]?.name ?? option}`)
      .join(', ');
  }

  /** A side of a pair (FLR-T-14.4): its version, in its design, checked drawable, and what it is in words. */
  async function pairSide(tx: Tx, projectId: string, side: z.infer<typeof PairSide> | undefined, which: 'A' | 'B') {
    let version: Awaited<ReturnType<typeof versionFor>>;
    let label: string;
    if (side?.changeset !== undefined) {
      const id = side.changeset.toLowerCase();
      const head = await tx.head.findUnique({ where: { projectId_name: { projectId, name: changesetHead(id) } } });
      const changeset = head === null ? null : await tx.changeset.findFirst({ where: { id, projectId }, select: { name: true } });
      if (head === null || changeset === null) throw new HttpError(404, `${which}'s changeset was not found, or is no longer pending`);
      version = await versionFor(tx, projectId, head.versionHash);
      label = `Changeset · ${changeset.name}`;
    } else if (side?.version !== undefined) {
      version = await versionFor(tx, projectId, side.version);
      label = version.seq === null ? `Version ${version.hash.slice(0, 8)}` : `v${String(version.seq)}`;
    } else {
      version = await versionFor(tx, projectId, undefined);
      label = version.seq === null ? 'Main' : `Main v${String(version.seq)}`;
    }
    const design = side?.design;
    const ev = evaluate(version.document as object, design === undefined ? OFFICIAL_READER : { ...OFFICIAL_READER, design });
    if (!ev.valid || ev.document === undefined)
      throw new ProblemError({ status: 422, type: 'not-drawable', title: `${which} cannot be drawn`, detail: 'Its model is not valid. Run validate to see why.' });
    if (design !== undefined && (ev.design === null || ev.view === undefined))
      throw new ProblemError({ status: 422, type: 'not-drawable', title: `${which}'s design cannot be drawn`, detail: 'The design names no design of that model, or that design is not valid.' });
    if (design !== undefined && Object.keys(design).length > 0) label = `${label} · ${designWords(version.document, design)}`;
    return { version, design, label, document: ev.document };
  }

  /** Queue a matched pair (FLR-T-14.4): both sides checked, the camera found, a render place free. */
  async function queuePair(req: Request, tx: Tx, body: z.infer<typeof ExportBody>) {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const extra = (['version', 'design', 'levels', 'page', 'still', 'shots', 'film', 'doors', 'lighting', 'mode', 'layers', 'style', 'renovation'] as const).filter((k) => body[k] !== undefined);
    if (extra.length > 0) throw new HttpError(400, `a pair names its sides in pair.a and pair.b, and takes nothing else: drop ${extra.join(', ')}`);
    const parsed = PairBody.safeParse(body.pair ?? {});
    if (!parsed.success) throw new HttpError(400, 'the pair is not valid', { fields: parsed.error.issues.map((i) => ({ path: ['pair', ...i.path].join('.'), message: i.message })) });
    const pair = parsed.data;
    const cameras = [pair.view, pair.camera, pair.shot].filter((c) => c !== undefined).length;
    if (cameras > 1) throw new HttpError(400, 'a pair is seen through one camera: a saved view, a named camera or a shot');
    if (!shotWithinBudget(pair.size, pair.quality)) throw new HttpError(400, `a ${pair.size} pair at ${pair.quality} quality is more work than a still may take: choose a smaller size or a lower quality`);
    const a = await pairSide(tx, project.id, pair.a, 'A');
    const b = await pairSide(tx, project.id, pair.b, 'B');
    if (a.version.hash === b.version.hash && JSON.stringify(a.design ?? {}) === JSON.stringify(b.design ?? {})) throw new HttpError(400, 'A and B are the same design: compare two different ones');
    // The camera: a saved view of A's (or B's) document, a named view, or the editor's as a view record.
    let view: string | undefined;
    if (pair.view !== undefined) {
      const saved = savedViewNamed(a.document, pair.view) ?? savedViewNamed(b.document, pair.view);
      if (saved === undefined) {
        const views = savedViewsOf(a.document).map((v) => `"${v.name}"`);
        throw new HttpError(400, `the model has no saved view "${pair.view}"; ${views.length === 0 ? 'it has none (FS_views)' : `its views are ${views.join(', ')}`}`);
      }
      view = saved.id;
    }
    if (pair.shot !== undefined) {
      if (JSON.stringify(pair.shot).length > 4000) throw new HttpError(400, 'the shot is too long to be a view');
      if (readView('shot', pair.shot) === undefined) throw new HttpError(400, 'a shot is a view as FS_views records one: a name, an eye and a target in base units, and its lens');
    }
    const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: RENDERING }, status: { in: ['queued', 'running'] } } });
    if (rendering > 0) throw new HttpError(429, 'a pair, a still, a shot list or a film is already rendering for this project; wait for it to finish');
    const renders = await tx.job.count({ where: { projectId: project.id, kind: 'render.3d', status: { in: ['queued', 'running'] } } });
    if (renders >= MAX_PENDING_RENDERS) throw new HttpError(429, `this project already has ${String(renders)} 3D renders waiting; try again when one finishes`);
    const pending = await tx.job.count({ where: { projectId: project.id, kind: { startsWith: 'export.' }, status: { in: ['queued', 'running'] } } });
    if (pending >= MAX_PENDING) throw new HttpError(429, `this project already has ${String(pending)} exports waiting; try again when one finishes`);
    const params: Params = {
      ...(a.design === undefined ? {} : { design: a.design }),
      aLabel: a.label,
      pair: { hash: b.version.hash, seq: b.version.seq, label: b.label, ...(b.design === undefined ? {} : { design: b.design }) },
      ...(view === undefined ? {} : { view }),
      ...(pair.camera === undefined ? {} : { camera: pair.camera }),
      ...(pair.shot === undefined ? {} : { shot: pair.shot as Prisma.InputJsonObject }),
      size: pair.size,
      quality: pair.quality,
      versionSeq: a.version.seq,
      versionAt: a.version.at.toISOString(),
    };
    const job = await tx.job.create({
      data: {
        projectId: project.id,
        kind: 'export.pair',
        params,
        versionHash: a.version.hash,
        requestedByAccountId: req.auth?.accountId ?? req.token?.accountId ?? null,
        requestedByTokenId: req.auth === undefined ? (req.token?.tokenId ?? null) : null,
      },
    });
    return {
      reply: (res: Response) => res.status(202).location(`/api/projects/${project.id}/exports/${job.id}`).json({ export: exportView(project.id, job) }),
      audit: {
        action: 'export.request',
        targetType: 'job',
        targetId: job.id,
        detail: { projectId: project.id, kind: 'pair', version: a.version.hash, ...(a.design === undefined ? {} : { design: a.design }), pair: { b: b.version.hash, ...(b.design === undefined ? {} : { design: b.design }), view: view ?? null, camera: pair.camera ?? null, shot: pair.shot !== undefined, size: pair.size, quality: pair.quality } },
      },
    };
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
      if (body.kind === 'pair') return queuePair(req, tx, body);
      if (body.pair !== undefined) throw new HttpError(400, 'only a pair takes pair options');
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
      if (body.film !== undefined && body.kind !== 'film') throw new HttpError(400, 'only a film takes film options');
      if (body.tour !== undefined && body.kind !== 'tour') throw new HttpError(400, 'only a tour takes tour options');
      if (body.doors !== undefined && body.kind !== 'gltf' && body.kind !== 'usdz') throw new HttpError(400, 'only a glTF or USDZ model takes doors');
      if (body.lighting !== undefined && body.kind !== 'gltf' && body.kind !== 'usdz') throw new HttpError(400, 'only a glTF or USDZ model takes a lighting');
      if (body.ar !== undefined && body.kind !== 'usdz') throw new HttpError(400, 'only a USDZ is made for AR Quick Look: only it takes ar options');
      if ((body.mode !== undefined || body.layers !== undefined) && body.kind !== 'pdf' && body.kind !== 'dxf') throw new HttpError(400, 'a mode is a view of the plan: only a PDF or DXF drawing takes one');
      if (body.renovation !== undefined && body.kind !== 'pdf' && body.kind !== 'dxf') throw new HttpError(400, 'a renovation plan is a drawing: only a PDF or DXF takes one');
      if (body.style !== undefined && body.kind !== 'pdf') throw new HttpError(400, 'a plan style is how a sheet is drawn: only a PDF takes one');
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
        const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: RENDERING }, status: { in: ['queued', 'running'] } } });
        if (rendering > 0) throw new HttpError(429, 'a still, a shot list, a film or a pair is already rendering for this project; wait for it to finish');
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
        const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: RENDERING }, status: { in: ['queued', 'running'] } } });
        if (rendering > 0) throw new HttpError(429, 'a shot list, a still, a film or a pair is already rendering for this project; wait for it to finish');
        const renders = await tx.job.count({ where: { projectId: project.id, kind: 'render.3d', status: { in: ['queued', 'running'] } } });
        if (renders >= MAX_PENDING_RENDERS) throw new HttpError(429, `this project already has ${String(renders)} 3D renders waiting; try again when one finishes`);
      }
      const filmBody = body.kind === 'film' ? FilmBody.parse(body.film ?? {}) : undefined;
      let film: { id: string; name: string; frames: number; samples?: number; timelapse?: { date: string; from: string; to: string; lightsAtDusk: boolean } } | undefined;
      if (filmBody !== undefined) {
        if (body.levels !== undefined || body.page !== undefined) throw new HttpError(400, 'a film is its keyframes’ views: it takes no levels or page');
        const films = filmsOf(ev.document);
        if (films.length === 0) throw new ProblemError({ status: 422, type: 'no-films', title: 'this model has no films', detail: 'Make a film from saved views in the 3D view’s Camera panel, or add one with setProperty of $document at /extras/d3floorspec/films/F1.' });
        const found = filmBody.film === undefined ? films[0] : filmNamed(ev.document, filmBody.film);
        if (found === undefined) throw new HttpError(400, `the model has no film "${filmBody.film ?? ''}"; its films are ${films.map((f) => `"${f.name}"`).join(', ')}`);
        const problem = filmProblem(found);
        if (problem !== null) throw new ProblemError({ status: 422, type: 'film-not-renderable', title: 'this film cannot be rendered', detail: `“${found.name}”: ${problem}.` });
        const lacking = filmShots(found, savedViewsOf(ev.document)).missing;
        if (lacking.length > 0) throw new ProblemError({ status: 422, type: 'film-not-renderable', title: 'this film cannot be rendered', detail: `“${found.name}” names saved views the model does not have: ${lacking.join(', ')}.` });
        const frames = filmFrameCount(filmDuration(found), filmBody.fps);
        const choice = filmChoiceProblem(filmBody.quality, filmBody.size, frames);
        if (choice !== null) throw new HttpError(400, choice);
        let timelapse: { date: string; from: string; to: string; lightsAtDusk: boolean } | undefined;
        if (filmBody.light === 'day-to-night') {
          const location = (ev.document as { site?: { location?: { latitude?: unknown; longitude?: unknown } } }).site?.location;
          const site = typeof location?.latitude === 'number' && typeof location.longitude === 'number' ? { latitude: location.latitude / 1e6, longitude: location.longitude / 1e6 } : {};
          const t = filmBody.timelapse ?? {};
          const date = t.date ?? midsummer(new Date().getUTCFullYear());
          let preset;
          try {
            preset = timelapseAround(date, site);
          } catch {
            throw new HttpError(400, 'the timelapse’s date is not a day of the calendar');
          }
          timelapse = { date, from: t.from ?? preset.from, to: t.to ?? preset.to, lightsAtDusk: t.lightsAtDusk ?? true };
          const bad = timelapseProblem(timelapse);
          if (bad !== null) throw new HttpError(400, `the timelapse is not valid: ${bad}`);
        } else if (filmBody.timelapse !== undefined) throw new HttpError(400, 'a timelapse is for a film in the day-to-night light');
        const samples = filmBody.quality === 'final' ? finalSamples(filmBody.size) : null;
        film = { id: found.id, name: found.name, frames, ...(samples === null ? {} : { samples }), ...(timelapse === undefined ? {} : { timelapse }) };
        // One film, still or shot list renders at a time per project: each takes the worker for a while.
        const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: RENDERING }, status: { in: ['queued', 'running'] } } });
        if (rendering > 0) throw new HttpError(429, 'a film, a still, a shot list or a pair is already rendering for this project; wait for it to finish, or cancel it');
      }
      const tourBody = body.kind === 'tour' ? TourBody.parse(body.tour ?? {}) : undefined;
      let tour: { rooms: { room: string; name: string; view?: string }[]; at: string } | undefined;
      if (tourBody !== undefined) {
        if (body.levels !== undefined || body.page !== undefined) throw new HttpError(400, 'a tour is its rooms’ panoramas: it takes no levels or page');
        if (!tourWithinBudget(tourBody.size, tourBody.quality)) throw new HttpError(400, `a ${tourBody.size} panorama at ${tourBody.quality} quality is more work than a still may take: choose a smaller size or a lower quality`);
        const view = ev.view ?? ev.document;
        const all = Object.entries(view.rooms ?? {}).flatMap(([id, r]) => (r === undefined ? [] : [{ id, name: r.name ?? id }]));
        const find = (key: string) => all.find((r) => r.id === key) ?? all.find((r) => r.name.toLowerCase() === key.toLowerCase());
        const asked: { room: string; view?: string | undefined }[] = tourBody.rooms ?? tourRoomsByDefault(view).map((room) => ({ room }));
        if (asked.length === 0) throw new ProblemError({ status: 422, type: 'no-rooms', title: 'this model has no rooms to tour', detail: 'A tour is a panorama of each room: draw rooms first, or name the ones to visit.' });
        const rooms: { room: string; name: string; view?: string }[] = [];
        for (const stop of asked) {
          const room = find(stop.room);
          if (room === undefined) throw new HttpError(400, `the model has no room ${stop.room}`);
          if (rooms.some((r) => r.room === room.id)) throw new HttpError(400, `${room.name} is in the tour twice`);
          let seen: string | undefined;
          if (stop.view !== undefined) {
            const saved = savedViewNamed(ev.document, stop.view);
            if (saved === undefined) {
              const views = savedViewsOf(ev.document).map((v) => `"${v.name}"`);
              throw new HttpError(400, `the model has no saved view "${stop.view}"; ${views.length === 0 ? 'it has none (FS_views)' : `its views are ${views.join(', ')}`}`);
            }
            seen = saved.id;
          }
          rooms.push({ room: room.id, name: room.name, ...(seen === undefined ? {} : { view: seen }) });
        }
        tour = { rooms, at: tourAt(new Date().getUTCFullYear()) };
        // One tour, film, still or shot list renders at a time per project.
        const rendering = await tx.job.count({ where: { projectId: project.id, kind: { in: RENDERING }, status: { in: ['queued', 'running'] } } });
        if (rendering > 0) throw new HttpError(429, 'a tour, a film, a still, a shot list or a pair is already rendering for this project; wait for it to finish, or cancel it');
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
        ...(body.style === undefined ? {} : { style: body.style }),
        ...(body.renovation === undefined ? {} : { renovation: body.renovation }),
        ...(body.doors === undefined ? {} : { doors: body.doors }),
        ...(body.ar === undefined ? {} : { ar: { scale: body.ar.scale, ...(body.ar.roofs === undefined ? {} : { roofs: body.ar.roofs }), ...(body.ar.furniture === undefined ? {} : { furniture: body.ar.furniture }), ...(body.ar.fixtures === undefined ? {} : { fixtures: body.ar.fixtures }), ...(body.ar.site === undefined ? {} : { site: body.ar.site }) } }),
        ...(body.lighting === undefined ? {} : { lighting: { on: Object.fromEntries(Object.entries(body.lighting.on).map(([id, s]) => [id, { ...(s.output === undefined ? {} : { output: s.output }), ...(s.cct === undefined ? {} : { cct: s.cct }) }])) } }),
        ...(shots === undefined ? {} : { ...(shots.views === undefined ? {} : { views: [...new Set(shots.views)] }), size: shots.size, quality: shots.quality }),
        ...(tourBody === undefined || tour === undefined ? {} : { rooms: tour.rooms, size: tourBody.size, quality: tourBody.quality, eyeHeight: tourBody.eyeHeight, at: tour.at }),
        ...(filmBody === undefined || film === undefined
          ? {}
          : { film: film.id, filmName: film.name, quality: filmBody.quality, format: filmBody.format, size: filmBody.size, fps: filmBody.fps, frames: film.frames, light: filmBody.light, ...(film.samples === undefined ? {} : { samples: film.samples }), ...(film.timelapse === undefined ? {} : { timelapse: film.timelapse }) }),
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
        audit: { action: 'export.request', targetType: 'job', targetId: job.id, detail: { projectId: project.id, kind: body.kind, version: version.hash, levels: params.levels ?? null, page: params.page ?? null, ...(params.design === undefined ? {} : { design: params.design }), ...(params.mode === undefined ? {} : { mode: params.mode }), ...(params.style === undefined ? {} : { style: params.style }), ...(params.renovation === undefined ? {} : { renovation: params.renovation }), ...(params.doors === undefined ? {} : { doors: params.doors }), ...(params.ar === undefined ? {} : { ar: params.ar }), ...(still === undefined ? {} : { still: { camera: params.camera ?? null, room: params.room ?? null, level: params.level ?? null, size: params.size, quality: params.quality } }), ...(shots === undefined ? {} : { shots: { views: params.views ?? null, size: params.size, quality: params.quality } }), ...(film === undefined ? {} : { film: { id: film.id, quality: params.quality, format: params.format, size: params.size, fps: params.fps, frames: film.frames, light: params.light } }), ...(tour === undefined ? {} : { tour: { rooms: tour.rooms.map((r) => r.room), size: params.size, quality: params.quality, eyeHeight: params.eyeHeight } }) } },
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

  /**
   * Cancel an export still queued or running (FLR-T-14.1): it is marked failed, as cancelled, and a
   * worker running it stops at its next report of progress. Anything else is already finished.
   */
  routes.mutate(
    'POST',
    '/:projectId/exports/:jobId/cancel',
    async (req, tx) => {
      const job = await jobOf(req);
      if (job.status !== 'queued' && job.status !== 'running') throw new HttpError(409, `this export is already ${job.status === 'done' ? 'done' : 'stopped'}`);
      const updated = await tx.job.update({ where: { id: job.id }, data: { status: 'failed', error: 'Cancelled.', result: { cancelled: true }, finishedAt: new Date(), lockedBy: null, progress: Prisma.DbNull } });
      return {
        reply: (res) => res.status(200).json({ export: exportView(job.projectId, updated) }),
        audit: { action: 'export.cancel', targetType: 'job', targetId: job.id, detail: { projectId: job.projectId, kind: job.kind.replace(/^export\./, ''), was: job.status } },
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
      // A tour (FLR-T-14.2): its manifest, panoramas and plans, in one ZIP made as it is asked for.
      if (job.kind === 'export.tour') {
        const assets = await db.jobAsset.findMany({ where: { jobId: job.id }, orderBy: { path: 'asc' } });
        const zip = storeZip([{ name: 'tour.json', bytes: new Uint8Array(output.bytes) }, ...assets.map((a) => ({ name: a.path, bytes: new Uint8Array(a.bytes) }))]);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${output.name.replace(/\.json$/, '.zip').replace(/[^\w.-]/g, '_')}"`);
        res.setHeader('ETag', `"${output.sha256}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
        return;
      }
      res.setHeader('Content-Type', output.contentType);
      // A USDZ asked for `?inline=1` (FLR-T-14.3): what an iPhone's or iPad's `<a rel="ar">` opens in AR Quick Look.
      const inline = job.kind === 'export.usdz' && req.query['inline'] === '1';
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${output.name.replace(/[^\w.-]/g, '_')}"`);
      res.setHeader('ETag', `"${output.sha256}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(output.bytes));
    },
    { token: 'read' },
  );

  return routes;
}
