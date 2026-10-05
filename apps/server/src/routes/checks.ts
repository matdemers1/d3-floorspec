import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { OFFICIAL_READER, validate } from '@floorspec/engine';
import { findingsFor, NOTICE, type Units } from '@floorspec/rules-engine';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';
import { changesetHead } from '../domain/history.js';
import { RENDER_3D_PENDING, RENDER_PENDING, type PlanRenderer } from '../render.js';
import { NO_PACKS, type InstalledPacks } from '../rules/packs.js';
import { profileOfProject } from '../rules/profiles.js';

const RenderQuery = z.object({
  view: z.enum(['plan', '3d']).optional(),
  changeset: z.string().optional(),
  level: z.string().min(1).max(64).optional(),
  highlight: z.string().max(2000).optional(),
  width: z.coerce.number().int().min(64).max(4096).optional(),
  theme: z.enum(['light', 'dark']).optional(),
});

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
export function checkRoutes(db: Db, renderer: PlanRenderer | null, rules: InstalledPacks = NO_PACKS, coverageUrl = '/rule-packs'): Routes {
  const routes = new Routes(db);

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

  /** Schema, invariant and lint diagnostics (Core chapter 10), from the reference engine. */
  routes.read(
    '/:projectId/validate',
    async (req, res) => {
      const { head, hash, document } = await documentAt(req);
      const result = validate(document as object, OFFICIAL_READER);
      res.json({ head, hash, valid: result.valid, diagnostics: result.diagnostics });
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
      const { head, hash, document } = await documentAt(req);
      const chosen = await profileOfProject(db, req.project as { ruleProfileId: string | null }, rules);
      const about = { profile: chosen.profile.name, profileId: chosen.id, notice: NOTICE, coverageUrl };
      if (rules.packs.length === 0) {
        res.json({ head, hash, findings: [], rulePacks: [], note: NO_RULE_PACKS, ...about });
        return;
      }
      const report = findingsFor(document as object, chosen.profile, rules.packs, { units: unitsOf(document) });
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

  /** A plan render as PNG. 3D arrives in Phase 7; the plan with FLR-T-2.8. */
  routes.read(
    '/:projectId/render',
    async (req, res) => {
      const view = req.query['view'] ?? 'plan';
      if (view !== 'plan' && view !== '3d') throw new HttpError(400, 'view is "plan" or "3d"');
      const { hash, document, base } = await documentAt(req);
      if (view === '3d') throw new ProblemError({ status: 501, type: 'not-available', title: RENDER_3D_PENDING });
      if (renderer === null) throw new ProblemError({ status: 501, type: 'not-available', title: RENDER_PENDING });
      const options = RenderQuery.safeParse(req.query);
      if (!options.success) throw new HttpError(400, 'the render options are not valid', { fields: options.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      const { level, highlight, width, theme } = options.data;
      let png: Uint8Array;
      try {
        png = await renderer.renderPlanPng(document as object, {
          ...(level === undefined ? {} : { level }),
          ...(highlight === undefined ? {} : { highlight: highlight.split(',').filter((id) => id.length > 0) }),
          ...(width === undefined ? {} : { width }),
          ...(theme === undefined ? {} : { theme }),
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
      res.setHeader('ETag', `"${hash}-${createHash('sha256').update(JSON.stringify(options.data)).digest('hex').slice(0, 16)}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(Buffer.from(png));
    },
    { token: 'read' },
  );

  return routes;
}
