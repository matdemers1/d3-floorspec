import { z } from 'zod';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { createProject, MAIN } from '../domain/projects.js';
import { canonicalJson, type Json } from '../model/canonical.js';
import { accountOf, parse } from './auth.js';

const CreateBody = z.object({ name: z.string().trim().min(1, 'a project needs a name').max(200) });

/**
 * Projects. Every `:projectId` route is guarded by the route builder: the project must exist, not
 * be deleted, and belong to the caller, or the answer is 404 (FLR-T-0.6).
 */
export function projectRoutes(db: Db): Routes {
  const routes = new Routes(db);

  routes.read('/', async (req, res) => {
    const projects = await db.project.findMany({
      where: { ownerAccountId: accountOf(req), deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, createdAt: true, updatedAt: true, heads: { where: { name: MAIN }, select: { versionHash: true } } },
    });
    res.json({
      projects: projects.map(({ heads, ...project }) => ({ ...project, head: heads[0]?.versionHash ?? null })),
    });
  });

  routes.mutate('POST', '/', async (req, tx) => {
    const { name } = parse(CreateBody, req.body);
    const { project, hash } = await createProject(tx, accountOf(req), name);
    return {
      reply: (res) => res.status(201).json({ id: project.id, name: project.name, createdAt: project.createdAt, head: hash }),
      audit: { action: 'project.create', targetType: 'project', targetId: project.id, detail: { name, version: hash } },
    };
  });

  routes.read('/:projectId', async (req, res) => {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const [head, ops] = await Promise.all([
      db.head.findUnique({ where: { projectId_name: { projectId: project.id, name: MAIN } } }),
      db.opLog.count({ where: { projectId: project.id } }),
    ]);
    res.json({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      head: head === null ? null : { name: head.name, version: head.versionHash, updatedAt: head.updatedAt },
      ops,
    });
  });

  /** The op log, newest first. Append-only, so this is the project's whole history. */
  routes.read('/:projectId/ops', async (req, res) => {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const ops = await db.opLog.findMany({
      where: { projectId: project.id },
      orderBy: { seq: 'desc' },
      take: 200,
      select: { seq: true, authorKind: true, authorAccountId: true, authorAgent: true, ops: true, beforeHash: true, afterHash: true, createdAt: true },
    });
    res.json({ ops });
  });

  /**
   * The model as a file: the canonical bytes of the document `main` points at — keys sorted, two
   * spaces, LF, a final newline — so a download diffs cleanly against the last one. The ETag is
   * the content hash, which is also the version's key.
   */
  routes.read('/:projectId/model.json', async (req, res) => {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    const head = await db.head.findUnique({
      where: { projectId_name: { projectId: project.id, name: MAIN } },
      include: { version: true },
    });
    if (head === null) throw new HttpError(404, 'this project has no model yet');
    const body = canonicalJson(head.version.document as Json);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="model.json"');
    res.setHeader('ETag', `"${head.versionHash}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(Buffer.from(body, 'utf8'));
  });

  /** Delete a project: soft, because its op log and versions are append-only and stay. */
  routes.mutate('DELETE', '/:projectId', async (req, tx) => {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    await tx.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'project.delete', targetType: 'project', targetId: project.id, detail: { name: project.name } },
    };
  });

  return routes;
}
