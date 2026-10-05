import type { Request } from 'express';
import { z } from 'zod';
import { canonicalize } from '@floorspec/engine';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import type { Comment, ShareLink } from '../generated/prisma/client.js';
import { Routes, type MutationResult } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import type { EventHub } from '../events/hub.js';
import type { ProjectEvent } from '../events/types.js';
import { NO_PACKS, type InstalledPacks } from '../rules/packs.js';
import { parse } from '../routes/auth.js';
import { cleanBody, commentEvent, MAX_BODY, threadsOf } from './comments.js';
import { sharedCoverage, sharedFindings } from './findings.js';
import { sameOrigin, shareContext, shareOf, writeBudget } from './guards.js';
import { shareLimits, type ShareLimits } from './limit.js';
import {
  DEFAULT_DAYS,
  hasElement,
  hasLevel,
  MAX_ACTIVE_LINKS,
  MAX_DAYS,
  mintShareToken,
  PREFIX_LENGTH,
  sharedVersion,
  showsOf,
  stateOf,
} from './links.js';
import { hashToken } from '../auth/sessions.js';
import { openFilteredStream, type StreamOptions } from './stream.js';

/**
 * Sharing (FLR-T-9.6): two sets of routes.
 *
 * **`/api/share/:token/*`** — what a share link reaches, and all it reaches. The reads are public:
 * the link's project name, the owner's display name, the version it shows, its model (when it shows
 * the plan or the 3D view), its findings and the packs' coverage (when it shows findings), and the
 * comments made through it. Writing a comment needs an account signed in with a session — an
 * invited account; there is no other kind — and comes from this app's pages (`sameOrigin`). The
 * token never selects anything but its one link: there is no project ID, version or link ID in
 * these paths for a caller to change.
 *
 * **`/api/projects/:projectId/shares` and `/comments`** — the owner's side: make, list and revoke
 * links, and read, answer, resolve and moderate every comment, guarded like every project route.
 */

export interface ShareDeps {
  readonly config: Config;
  readonly events: EventHub;
  readonly rules?: InstalledPacks;
  readonly limits?: ShareLimits;
  readonly stream?: StreamOptions;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Base units on a plan: plenty for any house (±1.5 km), and inside a Postgres integer. */
const Coordinate = z.number().int().min(-2_000_000_000).max(2_000_000_000);
const Body = z.string().max(MAX_BODY * 2, `a comment is at most ${String(MAX_BODY)} characters`);
const ElementId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'not an element ID');

const RootBody = z.strictObject({
  body: Body,
  element: ElementId,
  level: ElementId,
  point: z.tuple([Coordinate, Coordinate]).optional(),
});
const TextBody = z.strictObject({ body: Body });

const CreateShare = z
  .strictObject({
    label: z.string().trim().min(1, 'a label cannot be blank').max(80).optional(),
    expiresInDays: z.number().int().min(1).max(MAX_DAYS, `a link lasts at most ${String(MAX_DAYS)} days`).default(DEFAULT_DAYS),
    version: z.enum(['latest', 'current']).default('latest'),
    shows: z.strictObject({ plan: z.boolean(), threeD: z.boolean(), findings: z.boolean() }).default({ plan: true, threeD: true, findings: true }),
    comments: z.boolean().default(true),
  })
  .refine((b) => b.shows.plan || b.shows.threeD || b.shows.findings, { path: ['shows'], message: 'a link has to show something' })
  .refine((b) => !b.comments || b.shows.plan || b.shows.threeD, { path: ['comments'], message: 'comments are pinned to the plan or the 3D view: show one of them' });

/** A comment's text, cleaned, or a 400 that says why. */
function textOf(raw: string): string {
  const text = cleanBody(raw);
  if (text === '') throw new HttpError(400, 'the request body is not valid', { fields: [{ path: 'body', message: 'write something first' }] });
  if (text.length > MAX_BODY) throw new HttpError(400, 'the request body is not valid', { fields: [{ path: 'body', message: `a comment is at most ${String(MAX_BODY)} characters` }] });
  return text;
}

function signedIn(req: Request): string {
  const id = req.auth?.accountId;
  if (id === undefined) throw new HttpError(401, 'sign in first');
  return id;
}

function commentIdOf(req: Request): string {
  const id = String(req.params['commentId'] ?? '');
  if (!UUID.test(id)) throw new HttpError(404, 'comment not found');
  return id;
}

// ─── What a share link reaches ───────────────────────────────────────────────────────────────

export function shareRoutes(db: Db, deps: ShareDeps): Routes {
  const routes = new Routes(db);
  const limits = deps.limits ?? shareLimits();
  const rules = deps.rules ?? NO_PACKS;
  const context = shareContext(db, limits);
  const writes = [context, sameOrigin(deps.config), writeBudget(limits)];
  const pub = { access: 'public' as const, before: [context] };

  /** The shared version's document, when the link shows a view that draws it. */
  async function documentOf(link: ShareLink): Promise<{ hash: string; seq: number | null; pinned: boolean; document: unknown }> {
    const version = await sharedVersion(db, link);
    if (version === null) throw new HttpError(404, 'this project has no model yet');
    const row = await db.version.findUnique({ where: { hash: version.hash } });
    if (row === null) throw new HttpError(404, 'this project has no model yet');
    return { ...version, document: row.document };
  }

  /** What the viewer needs to lay itself out: no IDs, no emails, no history, no other project. */
  routes.read('/:token', async (req, res) => {
    const { link, project, ownerName } = shareOf(req);
    const [version, you] = await Promise.all([
      sharedVersion(db, link),
      req.auth === undefined ? null : db.account.findUnique({ where: { id: req.auth.accountId }, select: { displayName: true } }),
    ]);
    // Advisory, like a token's last use: never allowed to fail the request.
    void db.shareLink.update({ where: { id: link.id }, data: { viewCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined);
    res.json({
      project: { name: project.name },
      sharedBy: ownerName,
      version: version === null ? null : { hash: version.hash, seq: version.seq, pinned: version.pinned },
      shows: showsOf(link),
      comments: {
        allowed: link.allowComments,
        // Only a person in a session comments: a bearer token is never a commenter.
        signedIn: you !== null,
        you: you === null ? null : { name: you.displayName },
        owner: req.auth !== undefined && req.auth.accountId === project.ownerAccountId,
      },
      expiresAt: link.expiresAt,
    });
  }, pub);

  /** The shared version's canonical bytes; the ETag is its hash, so a revisit is a 304. */
  routes.read('/:token/model.json', async (req, res) => {
    const { link } = shareOf(req);
    if (!link.showPlan && !link.show3d) throw new HttpError(404, 'this link does not share the model');
    const { hash, document } = await documentOf(link);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('ETag', `"${hash}"`);
    // Asked again every time, so a revoked link stops at once; answered with a 304 when unchanged.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(Buffer.from(canonicalize(document), 'utf8'));
  }, pub);

  routes.read('/:token/findings', async (req, res) => {
    const { link, project } = shareOf(req);
    if (!link.showFindings) throw new HttpError(404, 'this link does not share findings');
    const { hash, document } = await documentOf(link);
    res.json(await sharedFindings(db, project, { hash, document }, rules));
  }, pub);

  routes.read('/:token/coverage', (req, res) => {
    const { link } = shareOf(req);
    if (!link.showFindings) throw new HttpError(404, 'this link does not share findings');
    res.json(sharedCoverage(rules));
  }, pub);

  routes.read('/:token/comments', async (req, res) => {
    const { link, project } = shareOf(req);
    if (!link.allowComments) throw new HttpError(404, 'this link does not share comments');
    res.json({ threads: await threadsOf(db, { projectId: project.id, linkId: link.id }, { you: req.auth?.accountId ?? null, owner: project.ownerAccountId, withLink: false }) });
  }, pub);

  /**
   * Live news for the viewer: a comment on this link, the model moving (a link that follows main),
   * the findings changing, the link being revoked — then the stream ends. Re-made field by field:
   * no account ID, author or other link reaches it.
   */
  routes.read('/:token/events', async (req, res) => {
    const { link, project } = shareOf(req);
    const untilExpiry = link.expiresAt.getTime() - Date.now();
    await openFilteredStream(req, res, deps.events, project.id, (event) => {
      const data = event.data as Record<string, unknown>;
      switch (event.type) {
        case 'comment':
          return link.allowComments && data['link'] === link.id ? { type: 'comment', data: { id: data['id'], thread: data['thread'], change: data['change'] } } : null;
        case 'head':
          return link.versionHash === null ? { type: 'model', data: { hash: data['hash'] } } : null;
        case 'profile':
          return link.showFindings ? { type: 'findings', data: {} } : null;
        case 'share':
          return data['id'] === link.id && data['change'] === 'revoked' ? { type: 'revoked', data: {}, end: true } : null;
        default:
          return null;
      }
    }, { ...deps.stream, maxAgeMs: Math.max(1_000, Math.min(deps.stream?.maxAgeMs ?? 15 * 60_000, untilExpiry)) });
  }, pub);

  /** Start a thread, pinned to an element of the version this link shows (FLR-REQ-167). */
  routes.mutate('POST', '/:token/comments', async (req, tx): Promise<MutationResult> => {
    const author = signedIn(req);
    const { link, project } = shareOf(req);
    if (!link.allowComments) throw new HttpError(403, 'this link does not take comments');
    const input = parse(RootBody, req.body);
    const body = textOf(input.body);
    const version = await sharedVersion(tx, link);
    const row = version === null ? null : await tx.version.findUnique({ where: { hash: version.hash } });
    if (version === null || row === null) throw new HttpError(409, 'this project has no model to comment on');
    if (!hasLevel(row.document, input.level) || !hasElement(row.document, input.element)) {
      throw new HttpError(409, 'that element is not in the version this link shows; reload and try again');
    }
    const comment = await tx.comment.create({
      data: {
        projectId: project.id,
        shareLinkId: link.id,
        authorAccountId: author,
        body,
        elementId: input.element,
        levelId: input.level,
        versionHash: version.hash,
        pointX: input.point?.[0] ?? null,
        pointY: input.point?.[1] ?? null,
      },
    });
    return written(db, comment, 'created', project.ownerAccountId, author, 201, {
      action: 'comment.create',
      detail: { project: project.id, link: link.id, element: input.element, level: input.level, version: version.hash, length: body.length },
    });
  }, { before: writes });

  routes.mutate('POST', '/:token/comments/:commentId/replies', async (req, tx): Promise<MutationResult> => {
    const author = signedIn(req);
    const { link, project } = shareOf(req);
    if (!link.allowComments) throw new HttpError(403, 'this link does not take comments');
    const root = await tx.comment.findFirst({ where: { id: commentIdOf(req), projectId: project.id, shareLinkId: link.id, parentId: null, deletedAt: null } });
    if (root === null) throw new HttpError(404, 'comment not found');
    const body = textOf(parse(TextBody, req.body).body);
    const reply = await tx.comment.create({
      data: { projectId: project.id, shareLinkId: link.id, parentId: root.id, authorAccountId: author, body, versionHash: root.versionHash },
    });
    return written(db, reply, 'replied', project.ownerAccountId, author, 201, {
      action: 'comment.reply',
      detail: { project: project.id, link: link.id, thread: root.id, length: body.length },
    });
  }, { before: writes });

  routes.mutate('PATCH', '/:token/comments/:commentId', async (req, tx): Promise<MutationResult> => {
    const author = signedIn(req);
    const { link, project } = shareOf(req);
    const own = await tx.comment.findFirst({ where: { id: commentIdOf(req), projectId: project.id, shareLinkId: link.id, authorAccountId: author, deletedAt: null } });
    // Somebody else's comment and no comment are the same answer.
    if (own === null) throw new HttpError(404, 'comment not found');
    const body = textOf(parse(TextBody, req.body).body);
    const edited = await tx.comment.update({ where: { id: own.id }, data: { body, editedAt: new Date() } });
    return written(db, edited, 'edited', project.ownerAccountId, author, 200, {
      action: 'comment.edit',
      detail: { project: project.id, link: link.id, length: body.length },
    });
  }, { before: writes });

  routes.mutate('DELETE', '/:token/comments/:commentId', async (req, tx): Promise<MutationResult> => {
    const author = signedIn(req);
    const { link, project } = shareOf(req);
    const own = await tx.comment.findFirst({ where: { id: commentIdOf(req), projectId: project.id, shareLinkId: link.id, authorAccountId: author, deletedAt: null } });
    if (own === null) throw new HttpError(404, 'comment not found');
    await tx.comment.update({ where: { id: own.id }, data: { body: '', deletedAt: new Date() } });
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'comment.delete', targetType: 'comment', targetId: own.id, detail: { project: project.id, link: link.id } },
      events: [commentEvent(own, 'deleted')],
    };
  }, { before: writes });

  return routes;
}

/** A written comment's answer, audit row and event. */
async function written(
  db: Db,
  comment: Comment,
  change: 'created' | 'replied' | 'edited',
  owner: string,
  you: string,
  status: number,
  audit: { action: string; detail: Record<string, unknown> },
): Promise<MutationResult> {
  const author = await db.account.findUnique({ where: { id: comment.authorAccountId }, select: { displayName: true } });
  const view = {
    id: comment.id,
    parent: comment.parentId,
    author: { name: author?.displayName ?? '', you: comment.authorAccountId === you, owner: comment.authorAccountId === owner },
    body: comment.body,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    deleted: false,
    pin:
      comment.elementId === null || comment.levelId === null
        ? null
        : { element: comment.elementId, level: comment.levelId, version: comment.versionHash, point: comment.pointX === null || comment.pointY === null ? null : [comment.pointX, comment.pointY] },
    resolved: null,
  };
  return {
    reply: (res) => res.status(status).json({ comment: view }),
    audit: { action: audit.action, targetType: 'comment', targetId: comment.id, detail: audit.detail },
    events: [commentEvent(comment, change)],
  };
}

// ─── The owner's side ────────────────────────────────────────────────────────────────────────

/** A link as its owner's list shows it: never its token, which was shown once. */
function linkView(link: ShareLink & { _count?: { comments: number } }) {
  return {
    id: link.id,
    label: link.label,
    prefix: link.prefix,
    shows: showsOf(link),
    comments: link.allowComments,
    version: link.versionHash === null ? { pinned: false, hash: null, seq: null } : { pinned: true, hash: link.versionHash, seq: link.versionSeq },
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    lastUsedAt: link.lastUsedAt,
    views: link.viewCount,
    commentCount: link._count?.comments ?? 0,
    state: stateOf(link),
  };
}

export function projectShareRoutes(db: Db, deps: ShareDeps): Routes {
  const routes = new Routes(db);
  const origin = sameOrigin(deps.config);
  const base = deps.config.PUBLIC_URL.replace(/\/+$/, '');

  const projectOf = (req: Request) => {
    const project = req.project;
    if (project === undefined) throw new HttpError(404, 'project not found');
    return project;
  };

  routes.read('/:projectId/shares', async (req, res) => {
    const project = projectOf(req);
    const links = await db.shareLink.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { _count: { select: { comments: { where: { deletedAt: null } } } } },
    });
    res.json({ links: links.map(linkView) });
  });

  /** Make a link. Its URL is in this response and nowhere else, ever. */
  routes.mutate('POST', '/:projectId/shares', async (req, tx): Promise<MutationResult> => {
    const project = projectOf(req);
    const owner = signedIn(req);
    const body = parse(CreateShare, req.body);
    const active = await tx.shareLink.count({ where: { projectId: project.id, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (active >= MAX_ACTIVE_LINKS) throw new HttpError(409, `a project has at most ${String(MAX_ACTIVE_LINKS)} live links; revoke one first`);
    let pin: { hash: string; seq: number } | null = null;
    if (body.version === 'current') {
      const now = await sharedVersion(tx, { projectId: project.id, versionHash: null, versionSeq: null });
      if (now === null) throw new HttpError(409, 'this project has no model to pin yet');
      pin = { hash: now.hash, seq: now.seq ?? 0 };
    }
    const token = mintShareToken();
    const createdAt = new Date();
    const link = await tx.shareLink.create({
      data: {
        projectId: project.id,
        createdByAccountId: owner,
        label: body.label ?? null,
        tokenHash: hashToken(token),
        prefix: token.slice(0, PREFIX_LENGTH),
        versionHash: pin?.hash ?? null,
        versionSeq: pin?.seq ?? null,
        showPlan: body.shows.plan,
        show3d: body.shows.threeD,
        showFindings: body.shows.findings,
        allowComments: body.comments,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + body.expiresInDays * 86_400_000),
      },
    });
    const events: ProjectEvent[] = [{ projectId: project.id, type: 'share', data: { id: link.id, change: 'created' } }];
    return {
      reply: (res) => res.status(201).json({ link: linkView(link), url: `${base}/s/${token}`, token }),
      audit: {
        action: 'share.create',
        targetType: 'share_link',
        targetId: link.id,
        detail: { project: project.id, label: link.label, prefix: link.prefix, expiresAt: link.expiresAt, shows: showsOf(link), comments: link.allowComments, version: pin },
      },
      events,
    };
  }, { before: [origin] });

  /** Revoke a link: it stops working at once, and its open streams end. Its comments stay, for the owner. */
  routes.mutate('DELETE', '/:projectId/shares/:shareId', async (req, tx): Promise<MutationResult> => {
    const project = projectOf(req);
    const id = String(req.params['shareId'] ?? '');
    if (!UUID.test(id)) throw new HttpError(404, 'share link not found');
    const link = await tx.shareLink.findFirst({ where: { id, projectId: project.id } });
    if (link === null) throw new HttpError(404, 'share link not found');
    if (link.revokedAt === null) await tx.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'share.revoke', targetType: 'share_link', targetId: id, detail: { project: project.id, label: link.label, prefix: link.prefix } },
      events: [{ projectId: project.id, type: 'share', data: { id, change: 'revoked' } }],
    };
  }, { before: [origin] });

  /** Every thread on the project, from every link, resolved or not, with the link it came through. */
  routes.read('/:projectId/comments', async (req, res) => {
    const project = projectOf(req);
    const you = req.auth?.accountId ?? req.token?.accountId ?? null;
    res.json({ threads: await threadsOf(db, { projectId: project.id }, { you, owner: project.ownerAccountId, withLink: true }) });
  }, { token: 'read' });

  /** The owner's live comments: every comment and link event on the project, no text. */
  routes.read('/:projectId/comments/events', async (req, res) => {
    const project = projectOf(req);
    await openFilteredStream(req, res, deps.events, project.id, (event) => {
      if (event.type === 'comment' || event.type === 'share') return { type: event.type, data: event.data };
      return null;
    }, deps.stream);
  });

  async function rootOf(tx: Tx, req: Request): Promise<Comment> {
    const project = projectOf(req);
    const root = await tx.comment.findFirst({ where: { id: commentIdOf(req), projectId: project.id, parentId: null } });
    if (root === null) throw new HttpError(404, 'comment not found');
    return root;
  }

  routes.mutate('POST', '/:projectId/comments/:commentId/replies', async (req, tx): Promise<MutationResult> => {
    const project = projectOf(req);
    const owner = signedIn(req);
    const root = await rootOf(tx, req);
    if (root.deletedAt !== null) throw new HttpError(404, 'comment not found');
    const body = textOf(parse(TextBody, req.body).body);
    const reply = await tx.comment.create({
      data: { projectId: project.id, shareLinkId: root.shareLinkId, parentId: root.id, authorAccountId: owner, body, versionHash: root.versionHash },
    });
    return written(db, reply, 'replied', project.ownerAccountId, owner, 201, {
      action: 'comment.reply',
      detail: { project: project.id, link: root.shareLinkId, thread: root.id, length: body.length },
    });
  }, { before: [origin] });

  routes.mutate('PATCH', '/:projectId/comments/:commentId', async (req, tx): Promise<MutationResult> => {
    const project = projectOf(req);
    const owner = signedIn(req);
    const own = await tx.comment.findFirst({ where: { id: commentIdOf(req), projectId: project.id, authorAccountId: owner, deletedAt: null } });
    if (own === null) throw new HttpError(404, 'comment not found');
    const body = textOf(parse(TextBody, req.body).body);
    const edited = await tx.comment.update({ where: { id: own.id }, data: { body, editedAt: new Date() } });
    return written(db, edited, 'edited', project.ownerAccountId, owner, 200, { action: 'comment.edit', detail: { project: project.id, link: own.shareLinkId, length: body.length } });
  }, { before: [origin] });

  /** The owner removes any comment on their project: their own, or one they will not keep. */
  routes.mutate('DELETE', '/:projectId/comments/:commentId', async (req, tx): Promise<MutationResult> => {
    const project = projectOf(req);
    const comment = await tx.comment.findFirst({ where: { id: commentIdOf(req), projectId: project.id, deletedAt: null } });
    if (comment === null) throw new HttpError(404, 'comment not found');
    await tx.comment.update({ where: { id: comment.id }, data: { body: '', deletedAt: new Date() } });
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'comment.delete', targetType: 'comment', targetId: comment.id, detail: { project: project.id, link: comment.shareLinkId, by: 'owner', own: comment.authorAccountId === project.ownerAccountId } },
      events: [commentEvent(comment, 'deleted')],
    };
  }, { before: [origin] });

  for (const verb of ['resolve', 'reopen'] as const) {
    routes.mutate('POST', `/:projectId/comments/:commentId/${verb}`, async (req, tx): Promise<MutationResult> => {
      const project = projectOf(req);
      const owner = signedIn(req);
      const root = await rootOf(tx, req);
      const resolved = verb === 'resolve';
      const updated =
        (root.resolvedAt !== null) === resolved
          ? root
          : await tx.comment.update({ where: { id: root.id }, data: resolved ? { resolvedAt: new Date(), resolvedByAccountId: owner } : { resolvedAt: null, resolvedByAccountId: null } });
      return {
        reply: (res) => res.json({ id: updated.id, resolved: updated.resolvedAt === null ? null : { at: updated.resolvedAt } }),
        audit: { action: `comment.${verb}`, targetType: 'comment', targetId: root.id, detail: { project: project.id, link: root.shareLinkId } },
        events: [commentEvent(root, resolved ? 'resolved' : 'reopened')],
      };
    }, { before: [origin] });
  }

  return routes;
}
