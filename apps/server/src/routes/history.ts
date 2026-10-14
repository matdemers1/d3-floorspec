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
  restoreBatch,
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
      /** The design option the batch edits in (Ops 0.3, 2.8): the applier judges whether it is one. */
      option: z.string().min(1).max(64).optional(),
      // `retired` is the store's to supply (Ops 1.5): a client cannot vouch for the project's history.
    })
    .optional(),
  /** Apply into this changeset — its handle, or a name to open or append to — rather than main. */
  changeset: z.string().trim().min(1).max(120).optional(),
});

const UndoBody = z.strictObject({}).optional();

/** FLR-T-18.14: a version of main, by the seq of the op that made it. */
const RestoreBody = z.strictObject({ seq: z.number().int().min(1) });
const BranchBody = z.strictObject({ seq: z.number().int().min(1), name: z.string().trim().min(1).max(120).optional() });

/** A restore that did not arrive exactly at the version asked for writes nothing. */
function inexact(seq: number, target: string, got: string): ProblemError {
  return new ProblemError({
    status: 409,
    type: 'restore-inexact',
    title: 'the restore did not arrive at that version, so nothing changed',
    detail: `v${String(seq)} is ${target}; taking back the ops after it gave ${got}.`,
  });
}

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
        ...(body.context?.option === undefined ? {} : { option: body.context.option }),
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
   * FLR-T-18.14: restore main to an earlier version — the history scrubber's Restore. One new op on
   * main: the stored inverses of every op after that version, newest first (`restoreBatch`). History
   * is appended to, never rewound; undo takes the restore back like any edit. Refused, writing
   * nothing, unless the result is exactly that version.
   */
  routes.mutate(
    'POST',
    '/:projectId/restore',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body = parse(RestoreBody, req.body);
      await lockProject(tx, project.id);
      const { batch, target, undone } = await restoreBatch(tx, project.id, body.seq);
      const outcome = await applyToHead(tx, applier, {
        projectId: project.id,
        head: MAIN,
        batch,
        author: authorOf(req),
        kind: 'apply',
        ifMatch: ifMatchOf(req),
        // The inverses bring removed elements back under their own IDs (Ops 1.6), as undo does.
        retiredExcept: { ids: idsNamedByAdds(batch) },
      });
      if (outcome.status === 'rejected') throw rejection(outcome.result, MAIN);
      if (outcome.result.hash !== target) throw inexact(body.seq, target, outcome.result.hash);
      const view = committedView(outcome);
      return {
        reply: (res) => {
          res.setHeader('ETag', `"${view.hash}"`);
          res.status(201).json({ ...view, restored: body.seq });
        },
        events: [headEvent(project.id, outcome.op)],
        audit: {
          action: 'ops.restore',
          targetType: 'project',
          targetId: project.id,
          detail: { seq: outcome.op.seq, to: body.seq, undone, before: outcome.before, after: view.hash },
        },
      };
    },
    { token: 'write' },
  );

  /**
   * FLR-T-18.14: branch from an earlier version — the scrubber's Branch. A changeset opened from main
   * (named, or "From v<seq>") whose first op returns it to that version; main does not move. Accepting
   * it is a person's decision, as for any changeset (FLR-ADR-016).
   */
  routes.mutate(
    'POST',
    '/:projectId/branch',
    async (req, tx): Promise<MutationResult> => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      const body = parse(BranchBody, req.body);
      const author = authorOf(req);
      await lockProject(tx, project.id);
      const { batch, target } = await restoreBatch(tx, project.id, body.seq);
      const { changeset: open, opened } = await openChangeset(tx, project.id, body.name ?? `From v${String(body.seq)}`, author);
      if (!opened) throw new HttpError(409, `a pending changeset is already called “${open.name}”`);
      // FLR-T-18.18: marked as a branch, so a replay makes its return again against main (domain/changesets.ts).
      const changeset = await tx.changeset.update({ where: { id: open.id }, data: { branchedFrom: body.seq } });
      const head = changesetHead(changeset.id);
      const outcome = await applyToHead(tx, applier, {
        projectId: project.id,
        head,
        batch,
        author,
        kind: 'apply',
        changesetId: changeset.id,
        retiredExcept: { ids: idsNamedByAdds(batch) },
      });
      if (outcome.status === 'rejected') throw rejection(outcome.result, head);
      if (outcome.result.hash !== target) throw inexact(body.seq, target, outcome.result.hash);
      const view = committedView(outcome);
      return {
        reply: (res) => res.status(201).json({ ...view, from: body.seq, changeset: changesetView(changeset, { head: view.hash }) }),
        events: [changesetEvent(changeset, 'opened', { hash: view.hash, ops: await countChangesetOps(tx, changeset) })],
        audit: {
          action: 'changeset.branch',
          targetType: 'changeset',
          targetId: changeset.id,
          detail: { project: project.id, name: changeset.name, from: body.seq, seq: outcome.op.seq, after: view.hash },
        },
      };
    },
    { token: 'propose' },
  );

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
          option: op.editOption,
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
