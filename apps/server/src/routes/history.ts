import type { Request } from 'express';
import { z } from 'zod';
import { canonicalize } from '@floorspec/engine';
import type { Db } from '../db.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { isAgent } from '../http/context.js';
import type { Applier, Batch, Rejected } from '../ops/applier.js';
import { idsNamedByAdds } from '../ops/applier.js';
import { MAIN } from '../domain/projects.js';
import {
  applyToHead,
  authorOf,
  changesetHead,
  lockProject,
  undoCandidates,
  undoTarget,
  type ApplyOutcome,
} from '../domain/history.js';
import { changesetView, openChangeset } from '../domain/changesets.js';
import { parse } from './auth.js';
import { changesetEvent, countChangesetOps, headEvent } from '../events/publish.js';

/** An operation: an object naming itself. Its members are the applier's to judge (Ops 1.1.1). */
const OpSchema = z.looseObject({ op: z.string().min(1).max(64) });

const LockSchema = z.union([
  z.strictObject({ element: z.string().min(1) }),
  z.strictObject({ length: z.string().min(1) }),
  z.strictObject({ distance: z.tuple([z.string().min(1), z.string().min(1)]) }),
]);

export const ApplyBody = z.strictObject({
  batch: z.array(OpSchema).min(1, 'a batch needs at least one operation').max(500),
  context: z
    .strictObject({
      locks: z.array(LockSchema).max(200).optional(),
      // `retired` is the store's to supply (Ops 1.5): a client cannot vouch for the project's history.
    })
    .optional(),
  /** Apply into this changeset — its handle, or a name to open or append to — rather than main. */
  changeset: z.string().trim().min(1).max(120).optional(),
});

const UndoBody = z.strictObject({}).optional();

/**
 * The 422 a rejected batch answers with: the applier's diagnostics, fix operations and all. Thrown,
 * so the transaction rolls back — including a changeset the same request would have opened.
 */
export function rejection(result: Rejected, head: string): ProblemError {
  return new ProblemError({
    status: 422,
    type: 'ops-rejected',
    title: 'the batch was rejected and nothing changed',
    detail: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join(' '),
    head,
    diagnostics: result.diagnostics,
  });
}

/** The answer to a committed edit. */
export function committedView(outcome: Extract<ApplyOutcome, { status: 'committed' }>) {
  return {
    status: 'committed' as const,
    head: outcome.op.head,
    before: outcome.before,
    hash: outcome.result.hash,
    op: { id: outcome.op.id, seq: outcome.op.seq, kind: outcome.op.kind },
    resolved: outcome.result.resolved,
    created: outcome.result.created,
    removed: outcome.result.removed,
  };
}

function ifMatchOf(req: Request): string | undefined {
  return req.get('if-match') ?? undefined;
}

/**
 * The op log and its versions (FLR-T-2.4): apply a batch, undo and redo, read any version a project
 * has been at, and the history of main.
 */
export function historyRoutes(db: Db, applier: Applier): Routes {
  const routes = new Routes(db);

  /**
   * Apply a request to a head. A person (session or write token) commits to main; an agent token
   * never does — its batches go into a named pending changeset (FLR-ADR-016), the one in
   * `changeset` or one named after the token. Anybody may aim a batch at a changeset explicitly.
   */
  routes.mutate(
    'POST',
    '/:projectId/ops',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body = parse(ApplyBody, req.body);
      const author = authorOf(req);
      const token = req.auth === undefined ? req.token : undefined;
      const target = body.changeset ?? (token !== undefined && isAgent(token) ? token.name : undefined);

      await lockProject(tx, project.id);
      let changeset = null;
      let opened = false;
      if (target !== undefined) ({ changeset, opened } = await openChangeset(tx, project.id, target, author));
      const head = changeset === null ? MAIN : changesetHead(changeset.id);

      const outcome = await applyToHead(tx, applier, {
        projectId: project.id,
        head,
        batch: body.batch,
        ...(body.context?.locks === undefined ? {} : { locks: body.context.locks }),
        author,
        kind: 'apply',
        ifMatch: opened ? undefined : ifMatchOf(req),
        changesetId: changeset?.id ?? null,
      });
      // Nothing is written — not even a changeset this request opened: the problem is thrown, and
      // the transaction goes with it.
      if (outcome.status === 'rejected') throw rejection(outcome.result, head);
      const view = committedView(outcome);
      const event =
        changeset === null
          ? headEvent(project.id, outcome.op)
          : changesetEvent(changeset, opened ? 'opened' : 'appended', { hash: view.hash, ops: await countChangesetOps(tx, changeset) });
      return {
        reply: (res) => {
          res.setHeader('ETag', `"${view.hash}"`);
          res.status(201).json({ ...view, changeset: changeset === null ? null : changesetView(changeset, { head: view.hash }) });
        },
        events: [event],
        audit: {
          action: changeset === null ? 'ops.apply' : 'changeset.apply',
          targetType: changeset === null ? 'project' : 'changeset',
          targetId: changeset?.id ?? project.id,
          detail: { project: project.id, head, seq: outcome.op.seq, before: outcome.before, after: view.hash, ops: body.batch.length, opened },
        },
      };
    },
    { token: 'propose' },
  );

  for (const mode of ['undo', 'redo'] as const) {
    /**
     * Undo the newest edit still in effect on main, or redo the newest undo, by applying its stored
     * inverse as a new op. History is appended to, never rewound.
     */
    routes.mutate(
      'POST',
      `/:projectId/${mode}`,
      async (req, tx): Promise<MutationResult> => {
        const project = req.project;
        if (project === undefined) throw new HttpError(404, 'project not found');
        parse(UndoBody, req.body);
        await lockProject(tx, project.id);
        const target = undoTarget(await undoCandidates(tx, project.id), mode);
        if (target === null) throw new HttpError(409, mode === 'undo' ? 'there is nothing on main to undo' : 'there is nothing on main to redo');
        const inverse = target.inverse as unknown as Batch;
        const outcome = await applyToHead(tx, applier, {
          projectId: project.id,
          head: MAIN,
          batch: inverse,
          author: authorOf(req),
          kind: mode,
          ifMatch: ifMatchOf(req),
          undoOfId: target.id,
          // The inverse brings removed elements back under their own IDs: the same elements
          // returning, which `retired` must not refuse (Ops 1.6).
          retiredExcept: { ids: idsNamedByAdds(inverse) },
        });
        if (outcome.status === 'rejected') throw rejection(outcome.result, MAIN);
        const view = committedView(outcome);
        return {
          reply: (res) => {
            res.setHeader('ETag', `"${view.hash}"`);
            res.status(201).json({ ...view, [mode === 'undo' ? 'undid' : 'redid']: target.seq });
          },
          events: [headEvent(project.id, outcome.op)],
          audit: {
            action: `ops.${mode}`,
            targetType: 'project',
            targetId: project.id,
            detail: { seq: outcome.op.seq, of: target.seq, before: outcome.before, after: view.hash },
          },
        };
      },
      { token: 'write' },
    );
  }

  /**
   * One version of the model, as canonical bytes — any version this project has been at, on main
   * or a changeset. Versions are shared between projects by hash, so a hash this project never
   * reached is a 404 here even if another project holds it.
   */
  routes.read(
    '/:projectId/versions/:hash',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const hash = String(req.params['hash']);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(404, 'version not found');
      const reached = await db.opLog.findFirst({
        where: { projectId: project.id, OR: [{ afterHash: hash }, { beforeHash: hash }] },
        select: { id: true },
      });
      if (reached === null) throw new HttpError(404, 'version not found');
      const version = await db.version.findUniqueOrThrow({ where: { hash } });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('ETag', `"${hash}"`);
      // Immutable: a hash names exactly one document, forever.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(Buffer.from(canonicalize(version.document), 'utf8'));
    },
    { token: 'read' },
  );

  /** Main's history, newest first, with what undo and redo would do next. */
  routes.read(
    '/:projectId/history',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100) || 100, 1), 500);
      const [ops, candidates, head] = await Promise.all([
        db.opLog.findMany({
          where: { projectId: project.id, head: MAIN },
          orderBy: { seq: 'desc' },
          take: limit,
          include: { authorAccount: { select: { displayName: true } }, undoOf: { select: { seq: true } }, changeset: { select: { id: true, name: true } } },
        }),
        undoCandidates(db, project.id),
        db.head.findUnique({ where: { projectId_name: { projectId: project.id, name: MAIN } } }),
      ]);
      res.json({
        head: head?.versionHash ?? null,
        undo: undoTarget(candidates, 'undo')?.seq ?? null,
        redo: undoTarget(candidates, 'redo')?.seq ?? null,
        ops: ops.map((op) => ({
          seq: op.seq,
          kind: op.kind,
          author: {
            kind: op.authorKind,
            account: op.authorAccountId,
            name: op.authorAgent ?? op.authorAccount?.displayName ?? null,
            token: op.authorTokenId,
          },
          ops: op.ops,
          resolved: op.resolved,
          inverse: op.inverse,
          created: op.created,
          removed: op.removed,
          before: op.beforeHash,
          after: op.afterHash,
          undoOf: op.undoOf?.seq ?? null,
          changeset: op.changeset,
          at: op.createdAt,
        })),
      });
    },
    { token: 'read' },
  );

  return routes;
}
