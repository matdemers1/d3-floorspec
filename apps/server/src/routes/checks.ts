import type { Request } from 'express';
import { validate } from '@floorspec/engine';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { MAIN } from '../domain/projects.js';
import { changesetHead } from '../domain/history.js';
import { RENDER_3D_PENDING, RENDER_PENDING, type PlanRenderer } from '../render.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No rule packs ship before Phase 6 (FLR-P-6); findings say so rather than look clean. */
export const NO_RULE_PACKS = 'No rule packs are installed yet: advisory code findings arrive in Phase 6. This is not a statement that the design meets any code.';

/**
 * Checks on a head — main, or a pending changeset with `?changeset=<id>`: validation by the
 * reference engine, advisory findings, and a plan render.
 */
export function checkRoutes(db: Db, renderer: PlanRenderer | null): Routes {
  const routes = new Routes(db);

  async function documentAt(req: Request): Promise<{ head: string; hash: string; document: unknown }> {
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
    return { head: name, hash: head.versionHash, document: head.version.document };
  }

  /** Schema, invariant and lint diagnostics (Core chapter 10), from the reference engine. */
  routes.read(
    '/:projectId/validate',
    async (req, res) => {
      const { head, hash, document } = await documentAt(req);
      const result = validate(document as object);
      res.json({ head, hash, valid: result.valid, diagnostics: result.diagnostics });
    },
    { token: 'read' },
  );

  /** Advisory code findings (FLR-ADR-011: rules advise, never block). Empty until Phase 6. */
  routes.read(
    '/:projectId/findings',
    async (req, res) => {
      const { head, hash } = await documentAt(req);
      res.json({ head, hash, findings: [], rulePacks: [], note: NO_RULE_PACKS });
    },
    { token: 'read' },
  );

  /** A plan render as PNG. 3D arrives in Phase 7; the plan with FLR-T-2.8. */
  routes.read(
    '/:projectId/render',
    async (req, res) => {
      const view = req.query['view'] ?? 'plan';
      if (view !== 'plan' && view !== '3d') throw new HttpError(400, 'view is "plan" or "3d"');
      const { hash, document } = await documentAt(req);
      if (view === '3d') throw new ProblemError({ status: 501, type: 'not-available', title: RENDER_3D_PENDING });
      if (renderer === null) throw new ProblemError({ status: 501, type: 'not-available', title: RENDER_PENDING });
      const level = typeof req.query['level'] === 'string' ? req.query['level'] : undefined;
      const png = await renderer.renderPlanPng(document, level === undefined ? {} : { level });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('ETag', `"${hash}${level === undefined ? '' : `-${level}`}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(Buffer.from(png));
    },
    { token: 'read' },
  );

  return routes;
}
