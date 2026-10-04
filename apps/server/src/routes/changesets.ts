import type { Request } from 'express';
import { z } from 'zod';
import { canonicalize } from '@floorspec/engine';
import type { Db } from '../db.js';
import type { ChangesetStatus } from '../generated/prisma/enums.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import type { Applier } from '../ops/applier.js';
import { MAIN } from '../domain/projects.js';
import { applyToHead, authorOf, changesetHead, lockProject } from '../domain/history.js';
import { acceptChangeset, changesetView, openChangeset, rejectChangeset } from '../domain/changesets.js';
import { ApplyBody, committedView, rejection } from './history.js';
import { parse } from './auth.js';

const ProposeBody = z.strictObject({
  name: z.string().trim().min(1, 'a changeset needs a name').max(120),
  batch: ApplyBody.shape.batch.optional(),
  context: ApplyBody.shape.context,
});

const DecideBody = z.strictObject({}).optional();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who decided: the person in the session, or the person whose write token it is. */
function personOf(req: Request): string {
  if (req.auth !== undefined) return req.auth.accountId;
  if (req.token !== undefined && !req.token.scopes.has('agent')) return req.token.accountId;
  throw new HttpError(403, 'an agent cannot accept or reject a changeset: a person does (FLR-ADR-016)');
}

/**
 * Changesets (FLR-T-2.5): list, read, propose, accept, reject. Accepting and rejecting is a
 * person's decision — a session, or that person's own write token — and never an agent's.
 */
export function changesetRoutes(db: Db, applier: Applier): Routes {
  const routes = new Routes(db);

  routes.read(
    '/:projectId/changesets',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const asked = req.query['status'];
      const status: ChangesetStatus | undefined = asked === 'all' ? undefined : asked === 'accepted' || asked === 'rejected' ? asked : 'pending';
      const where = status === undefined ? {} : { status };
      const changesets = await db.changeset.findMany({
        where: { projectId: project.id, ...where },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { _count: { select: { ops: true } } },
      });
      const heads = await db.head.findMany({
        where: { projectId: project.id, name: { in: changesets.map((c) => changesetHead(c.id)) } },
      });
      const headOf = new Map(heads.map((h) => [h.name, h.versionHash]));
      const main = await db.head.findUnique({ where: { projectId_name: { projectId: project.id, name: MAIN } } });
      res.json({
        main: main?.versionHash ?? null,
        changesets: changesets.map((c) => ({
          ...changesetView(c, { head: headOf.get(changesetHead(c.id)) ?? null, ops: c._count.ops }),
          // Whether accepting now would fast-forward or replay.
          fastForward: c.status === 'pending' ? main?.versionHash === c.baseHash : null,
        })),
      });
    },
    { token: 'read' },
  );

  routes.read(
    '/:projectId/changesets/:changesetId',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const id = String(req.params['changesetId']);
      if (!UUID.test(id)) throw new HttpError(404, 'changeset not found');
      const changeset = await db.changeset.findFirst({ where: { id, projectId: project.id } });
      if (changeset === null) throw new HttpError(404, 'changeset not found');
      const [head, main, ops] = await Promise.all([
        db.head.findUnique({ where: { projectId_name: { projectId: project.id, name: changesetHead(id) } } }),
        db.head.findUnique({ where: { projectId_name: { projectId: project.id, name: MAIN } } }),
        db.opLog.findMany({
          where: { projectId: project.id, changesetId: id, head: changesetHead(id) },
          orderBy: { seq: 'asc' },
          select: { seq: true, authorKind: true, authorAgent: true, ops: true, resolved: true, created: true, removed: true, beforeHash: true, afterHash: true, createdAt: true },
        }),
      ]);
      res.json({
        ...changesetView(changeset, { head: head?.versionHash ?? null, ops: ops.length }),
        fastForward: changeset.status === 'pending' ? main?.versionHash === changeset.baseHash : null,
        main: main?.versionHash ?? null,
        log: ops,
      });
    },
    { token: 'read' },
  );

  /** The model at a pending changeset's scratch head, as canonical bytes. */
  routes.read(
    '/:projectId/changesets/:changesetId/model.json',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const id = String(req.params['changesetId']);
      if (!UUID.test(id)) throw new HttpError(404, 'changeset not found');
      const head = await db.head.findUnique({
        where: { projectId_name: { projectId: project.id, name: changesetHead(id) } },
        include: { version: true },
      });
      if (head === null) throw new HttpError(404, 'changeset not found, or no longer pending');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('ETag', `"${head.versionHash}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(Buffer.from(canonicalize(head.version.document), 'utf8'));
    },
    { token: 'read' },
  );

  /** Propose: open a named changeset (or append to the pending one of that name), optionally with a batch. */
  routes.mutate(
    'POST',
    '/:projectId/changesets',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body = parse(ProposeBody, req.body);
      const author = authorOf(req);
      await lockProject(tx, project.id);
      const { changeset, opened } = await openChangeset(tx, project.id, body.name, author);
      const head = changesetHead(changeset.id);
      let applied = null;
      if (body.batch !== undefined) {
        const outcome = await applyToHead(tx, applier, {
          projectId: project.id,
          head,
          batch: body.batch,
          ...(body.context?.locks === undefined ? {} : { locks: body.context.locks }),
          author,
          kind: 'apply',
          changesetId: changeset.id,
        });
        if (outcome.status === 'rejected') throw rejection(outcome.result, head);
        applied = committedView(outcome);
      }
      const headHash = applied?.hash ?? (await tx.head.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: head } } })).versionHash;
      return {
        reply: (res) => res.status(opened ? 201 : 200).json({ changeset: changesetView(changeset, { head: headHash }), applied }),
        audit: {
          action: 'changeset.propose',
          targetType: 'changeset',
          targetId: changeset.id,
          detail: { project: project.id, name: changeset.name, opened, seq: applied?.op.seq ?? null },
        },
      };
    },
    { token: 'propose' },
  );

  routes.mutate(
    'POST',
    '/:projectId/changesets/:changesetId/accept',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      parse(DecideBody, req.body);
      const person = personOf(req);
      const changesetId = String(req.params['changesetId']);
      const outcome = await acceptChangeset(tx, applier, { projectId: project.id, changesetId, acceptedBy: person, ifMatch: req.get('if-match') });
      const changeset = await tx.changeset.findFirstOrThrow({ where: { id: changesetId, projectId: project.id } });
      return {
        reply: (res) => {
          res.setHeader('ETag', `"${outcome.hash}"`);
          res.json({
            changeset: changesetView(changeset),
            mode: outcome.mode === 'fast_forward' ? 'fast-forward' : 'replay',
            hash: outcome.hash,
            merged: outcome.ops.map((op) => op.seq),
          });
        },
        audit: {
          action: 'changeset.accept',
          targetType: 'changeset',
          targetId: changesetId,
          detail: { project: project.id, mode: outcome.mode, hash: outcome.hash, ops: outcome.ops.length },
        },
      };
    },
    { token: 'write' },
  );

  routes.mutate(
    'POST',
    '/:projectId/changesets/:changesetId/reject',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      parse(DecideBody, req.body);
      const person = personOf(req);
      const changeset = await rejectChangeset(tx, { projectId: project.id, changesetId: String(req.params['changesetId']), rejectedBy: person });
      return {
        reply: (res) => res.json({ changeset: changesetView(changeset) }),
        audit: { action: 'changeset.reject', targetType: 'changeset', targetId: changeset.id, detail: { project: project.id, name: changeset.name } },
      };
    },
    { token: 'write' },
  );

  return routes;
}
