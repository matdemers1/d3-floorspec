import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { evaluate, OFFICIAL_READER } from '@floorspec/engine';
import { findingsFor, NOTICE, type Units } from '@floorspec/rules-engine';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';
import { changesetHead } from '../domain/history.js';
import { RENDER_PENDING, type PlanRenderer } from '../render.js';
import { SHA256, type AssetStore } from '../assets/store.js';
import { NO_PACKS, type InstalledPacks } from '../rules/packs.js';
import { profileOfProject } from '../rules/profiles.js';

const RenderQuery = z.object({
  view: z.enum(['plan', '3d']).optional(),
  changeset: z.string().optional(),
  level: z.string().min(1).max(64).optional(),
  highlight: z.string().max(2000).optional(),
  width: z.coerce.number().int().min(64).max(4096).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  // 3D (FLR-T-8.5): a named view, or a room to stand in; and the design.
  camera: z.enum(['sw', 'se', 'ne', 'nw', 'top']).optional(),
  room: z.string().min(1).max(128).optional(),
  design: z.string().optional(),
});

/** The 3D render's widest picture: a software render, so its pixels are the worker's time. */
export const MAX_3D_WIDTH = 2048;
/** How many 3D renders a project may have waiting at once. */
export const MAX_PENDING_RENDERS = 3;

export interface Render3dWait {
  /** How long a 3D render request waits for the worker. Default 60 s. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/** The largest plan symbol embedded in a render: a symbol is a small drawing, never a photograph. */
export const MAX_SYMBOL_BYTES = 1_048_576;
/** How many distinct symbols one render reads. */
const MAX_SYMBOLS = 64;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The SHA-256 of every plan symbol a document's extension elements name (Core 12.6), sorted, at most MAX_SYMBOLS. */
export function symbolDigests(document: unknown): string[] {
  if (!isObject(document)) return [];
  const docAssets = isObject(document['assets']) ? document['assets'] : {};
  const extensions = isObject(document['extensions']) ? document['extensions'] : {};
  const out = new Set<string>();
  for (const ext of Object.values(extensions)) {
    const collections = isObject(ext) && isObject(ext['collections']) ? ext['collections'] : {};
    for (const coll of Object.values(collections)) {
      if (!isObject(coll)) continue;
      for (const el of Object.values(coll)) {
        const id = isObject(el) && isObject(el['fallback']) ? el['fallback']['symbol'] : undefined;
        const asset = typeof id === 'string' && Object.hasOwn(docAssets, id) ? docAssets[id] : undefined;
        const sha = isObject(asset) ? asset['sha256'] : undefined;
        if (typeof sha === 'string' && SHA256.test(sha)) out.add(sha);
      }
    }
  }
  return [...out].sort().slice(0, MAX_SYMBOLS);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** With no rule pack installed (RULE_PACKS_DIR), findings say so rather than look clean. */
export const NO_RULE_PACKS =
  'Nothing was checked: no rule pack is installed on this server yet. A pack is installed once a person has verified each of its rules against the code it cites; until then there are no findings, and that says nothing about any code.';

/** The display units a project chose in the editor (`/extras/d3floorspec/units`), for a finding's display values (Rules 9.6). */
function unitsOf(document: unknown): Units {
  const extras = (document as { extras?: { d3floorspec?: { units?: unknown } } } | null)?.extras;
  return extras?.d3floorspec?.units === 'metric' ? 'metric' : 'imperial';
}

/**
 * Checks on a head — main, or a pending changeset with `?changeset=<id>`: validation by the
 * reference engine, advisory findings, and a plan render.
 */
export function checkRoutes(db: Db, renderer: PlanRenderer | null, rules: InstalledPacks = NO_PACKS, coverageUrl = '/rule-packs', wait: Render3dWait = {}, assets: AssetStore | null = null): Routes {
  const routes = new Routes(db);

  /**
   * The bytes of the plan symbols a document's extension elements name (Core 12.6), for the plan
   * render (FLR-T-12.24) — only files the project's owner uploaded into one of their projects, as
   * the asset route serves them: a digest alone never reads somebody else's file. A symbol that is
   * not readable, or not stored, is left out and drawn as its kind's outline.
   */
  async function symbolBytes(document: unknown, ownerAccountId: string | undefined): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    if (assets === null || ownerAccountId === undefined) return out;
    const digests = symbolDigests(document);
    if (digests.length === 0) return out;
    const rows = await db.projectAsset.findMany({ where: { sha256: { in: digests }, project: { ownerAccountId } }, select: { sha256: true } });
    for (const sha256 of [...new Set(rows.map((r) => r.sha256))].sort()) {
      const bytes = await assets.get(sha256);
      if (bytes !== null && bytes.byteLength <= MAX_SYMBOL_BYTES) out.set(sha256, bytes);
    }
    return out;
  }

  async function documentAt(req: Request): Promise<{ head: string; hash: string; document: unknown; base: unknown }> {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const changeset = req.query['changeset'];
    let name = MAIN;
    if (typeof changeset === 'string' && changeset.length > 0) {
      if (!UUID.test(changeset)) throw new HttpError(404, 'changeset not found');
      name = changesetHead(changeset.toLowerCase());
    }
    const head = await db.head.findUnique({ where: { projectId_name: { projectId: project.id, name } }, include: { version: true } });
    if (head === null) throw new HttpError(404, name === MAIN ? 'this project has no model yet' : 'changeset not found, or no longer pending');
    // A changeset's base: what its proposal is drawn ghosted against.
    const base =
      name === MAIN
        ? null
        : (await db.changeset.findFirst({ where: { id: name.slice(3), projectId: project.id }, include: { base: { select: { document: true } } } }))?.base.document ?? null;
    return { head: name, hash: head.versionHash, document: head.version.document, base };
  }

  /**
   * Schema, invariant and lint diagnostics (Core chapter 10), from the reference engine. Validity
   * never depends on the design (Core 19.5): every checked design is validated, a diagnostic found
   * only in an option's design naming it in `design`. With `?design=`, the answer also says whether
   * Core derives that design (19.6.2) — `derives` — and which design it is.
   */
  routes.read(
    '/:projectId/validate',
    async (req, res) => {
      const design = designQuery(req.query['design']);
      const { head, hash, document } = await documentAt(req);
      const ev = evaluate(document as object, { ...OFFICIAL_READER, ...(design === undefined ? {} : { design }) });
      res.json({
        head,
        hash,
        valid: ev.valid,
        diagnostics: ev.diagnostics,
        ...(design === undefined ? {} : { design, derives: ev.valid && ev.view !== undefined }),
      });
    },
    { token: 'read' },
  );

  /**
   * Advisory code findings (FLR-ADR-011, FLR-REQ-098: rules advise, never block): the installed rule
   * packs evaluated against the committed head under the project's jurisdiction profile (FLR-T-6.8;
   * else the instance default — RULE_PROFILE, or the default profile, Rules 10.6), with the report's
   * notice, every rule's edition, and where the packs' coverage matrix is (FLR-REQ-096, 105). A
   * read, never part of an edit: no batch waits for it and no finding stops one. With no pack
   * installed, an empty list and a note that says nothing was checked.
   */
  routes.read(
    '/:projectId/findings',
    async (req, res) => {
      const design = designQuery(req.query['design']);
      const { head, hash, document } = await documentAt(req);
      const chosen = await profileOfProject(db, req.project as { ruleProfileId: string | null }, rules);
      const about = { profile: chosen.profile.name, profileId: chosen.id, notice: NOTICE, coverageUrl, ...(design === undefined ? {} : { design }) };
      if (rules.packs.length === 0) {
        res.json({ head, hash, findings: [], rulePacks: [], note: NO_RULE_PACKS, ...about });
        return;
      }
      const report = findingsFor(document as object, chosen.profile, rules.packs, { units: unitsOf(document), ...(design === undefined ? {} : { design }) });
      res.json({
        head,
        hash,
        findings: report.findings,
        rulePacks: rules.packs.map((p) => ({ name: p.name, version: p.version, title: p.title })),
        note: report.notice,
        ...about,
        ...(report.profile === undefined ? {} : { profile: report.profile }),
        ...(report.units === undefined ? {} : { units: report.units }),
        diagnostics: report.diagnostics,
        evaluated: report.evaluated,
        notEvaluated: report.notEvaluated,
        coverage: report.coverage,
      });
    },
    { token: 'read' },
  );

  /**
   * A 3D render (FLR-T-8.5): queued on the job queue as `render.3d` and drawn by the worker — the
   * worker container in production, this process's inline drain in development — while the request
   * waits for it. The job row records who asked; like the plan render, a render is a read, so no
   * audit row is written.
   */
  async function render3d(req: Request, at: { hash: string; document: unknown }, q: z.infer<typeof RenderQuery>): Promise<Uint8Array> {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    if ((q.width ?? 0) > MAX_3D_WIDTH) throw new HttpError(400, `a 3D render is at most ${String(MAX_3D_WIDTH)} pixels wide`);
    if (q.camera !== undefined && q.room !== undefined) throw new HttpError(400, 'a 3D render is from a named camera or from a room, not both');
    const design = designQuery(q.design);
    // Read as the worker renders it and as the editor validates it (OFFICIAL_READER, FLR-T-12.10).
    const ev = evaluate(at.document as object, { ...OFFICIAL_READER, ...(design === undefined ? {} : { design }) });
    if (!ev.valid || ev.document === undefined)
      throw new ProblemError({ status: 422, type: 'not-renderable', title: 'this model cannot be drawn in 3D', detail: 'The model is not valid. Run validate to see why.' });
    if (ev.view === undefined) throw new ProblemError({ status: 422, type: 'not-renderable', title: 'this design cannot be drawn', detail: 'The design names no design of this model, or that design is not valid.' });
    const pending = await db.job.count({ where: { projectId: project.id, kind: 'render.3d', status: { in: ['queued', 'running'] } } });
    if (pending >= MAX_PENDING_RENDERS) throw new HttpError(429, `this project already has ${String(pending)} 3D renders waiting; try again when one finishes`);
    const highlight = q.highlight?.split(',').filter((id) => id.length > 0);
    const job = await db.job.create({
      data: {
        projectId: project.id,
        kind: 'render.3d',
        params: {
          ...(q.camera === undefined ? {} : { camera: q.camera }),
          ...(q.room === undefined ? {} : { room: q.room }),
          ...(q.level === undefined ? {} : { level: q.level }),
          ...(highlight === undefined || highlight.length === 0 ? {} : { highlight }),
          ...(q.width === undefined ? {} : { width: q.width }),
          ...(design === undefined ? {} : { design }),
        },
        versionHash: at.hash,
        requestedByAccountId: req.auth?.accountId ?? req.token?.accountId ?? null,
        requestedByTokenId: req.auth === undefined ? (req.token?.tokenId ?? null) : null,
      },
    });
    const timeout = wait.timeoutMs ?? 60_000;
    const until = Date.now() + timeout;
    for (;;) {
      const now = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, error: true, output: { select: { bytes: true } } } });
      if (now.status === 'done' && now.output !== null) return new Uint8Array(now.output.bytes);
      if (now.status === 'failed')
        throw new ProblemError({ status: 422, type: 'not-renderable', title: 'this 3D view cannot be drawn', detail: `${now.error ?? 'The render failed.'} Run validate if the model may be the reason.` });
      if (Date.now() > until)
        throw new ProblemError({ status: 503, type: 'render-timeout', title: 'the 3D render did not finish in time', detail: `No worker drew it within ${String(Math.round(timeout / 1000))} s; it stays queued. Try again shortly.` });
      await new Promise((resolve) => setTimeout(resolve, wait.pollMs ?? 100));
    }
  }

  /** A render as PNG: the plan (FLR-T-2.8), or the 3D model drawn by the worker (FLR-T-8.5). */
  routes.read(
    '/:projectId/render',
    async (req, res) => {
      const view = req.query['view'] ?? 'plan';
      if (view !== 'plan' && view !== '3d') throw new HttpError(400, 'view is "plan" or "3d"');
      const { hash, document, base } = await documentAt(req);
      const options = RenderQuery.safeParse(req.query);
      if (!options.success) throw new HttpError(400, 'the render options are not valid', { fields: options.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      const etag = `"${hash}-${createHash('sha256').update(JSON.stringify(options.data)).digest('hex').slice(0, 16)}"`;
      if (view === '3d') {
        const png = await render3d(req, { hash, document }, options.data);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        res.send(Buffer.from(png));
        return;
      }
      if (renderer === null) throw new ProblemError({ status: 501, type: 'not-available', title: RENDER_PENDING });
      const { level, highlight, width, theme } = options.data;
      const symbols = await symbolBytes(document, req.project?.ownerAccountId);
      let png: Uint8Array;
      try {
        png = await renderer.renderPlanPng(document as object, {
          ...(level === undefined ? {} : { level }),
          ...(highlight === undefined ? {} : { highlight: highlight.split(',').filter((id) => id.length > 0) }),
          ...(width === undefined ? {} : { width }),
          ...(theme === undefined ? {} : { theme }),
          ...(symbols.size === 0 ? {} : { symbols }),
          ...(base === null ? {} : { ghost: { before: base as object } }),
        });
      } catch (error) {
        // The renderer draws valid plans; an invalid one is the document's problem, said plainly.
        throw new ProblemError({
          status: 422,
          type: 'not-renderable',
          title: 'this plan cannot be drawn',
          detail: `${error instanceof Error ? error.message : String(error)} Run validate to see why.`,
        });
      }
      res.setHeader('Content-Type', 'image/png');
      // One version drawn one way: the hash and the options that shaped the picture.
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(Buffer.from(png));
    },
    { token: 'read' },
  );

  return routes;
}

/**
 * A design input (Core 0.3, 19.6) from a query: `design=KS:KB,DS:D2` (option set:option, comma
 * separated) or the JSON object `design={"KS":"KB"}`. Absent: the primary design. Whether the sets
 * and options are the document's is the engine's to judge; a malformed value is a 400.
 */
export function designQuery(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never => {
    throw new HttpError(400, 'design is option set:option pairs, comma separated (design=KS:KB), or a JSON object of option set → option');
  };
  if (typeof raw !== 'string' || raw.length > 4000) return bad();
  const out: Record<string, string> = {};
  const put = (set: unknown, option: unknown): void => {
    if (typeof set !== 'string' || typeof option !== 'string' || !ID.test(set) || !ID.test(option) || Object.hasOwn(out, set)) bad();
    Object.defineProperty(out, set as string, { value: option, enumerable: true, writable: true, configurable: true });
  };
  if (raw.trim().startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return bad();
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bad();
    for (const [k, v] of Object.entries(parsed)) put(k, v);
    return out;
  }
  if (raw.trim() === '') return out;
  for (const pair of raw.split(',')) {
    const [set, option, ...rest] = pair.split(':');
    if (rest.length) bad();
    put(set?.trim(), option?.trim());
  }
  return out;
}

/** Core 3.1.1: the form of an ID. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
