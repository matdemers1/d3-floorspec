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
import { SHA256, type AssetStore } from '../assets/store.js';
import { digestsNamed, reachableFiles, sendAssetBytes } from '../assets/access.js';

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
 *
 * A virtual tour (FLR-T-14.2, FLR-ADR-057) is shared through a link of its own: one that names the
 * tour's export job and shows that tour and nothing else — no model, plan, findings or comments to
 * reach — view only and revocable like any link. `/api/share/:token/tour` answers the tour's state
 * (rendering, with its progress, until its panoramas are made) and then its manifest, and
 * `/api/share/:token/tour/:file` each panorama and plan the manifest names.
 */

export interface ShareDeps {
  readonly config: Config;
  readonly events: EventHub;
  readonly rules?: InstalledPacks;
  readonly limits?: ShareLimits;
  readonly stream?: StreamOptions;
  /** The asset store, for the shared version's textures (FLR-T-9.1's follow-up to FLR-T-9.6). */
  readonly assets?: AssetStore | null;
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

const NOTHING = { plan: false, threeD: false, findings: false };
const CreateShare = z
  .strictObject({
    label: z.string().trim().min(1, 'a label cannot be blank').max(80).optional(),
    expiresInDays: z.number().int().min(1).max(MAX_DAYS, `a link lasts at most ${String(MAX_DAYS)} days`).default(DEFAULT_DAYS),
    version: z.enum(['latest', 'current']).default('latest'),
    shows: z.strictObject({ plan: z.boolean(), threeD: z.boolean(), findings: z.boolean() }).optional(),
    comments: z.boolean().optional(),
    /** A virtual tour (FLR-T-14.2): its export job's ID. The link then shows that tour alone. */
    tour: z.string().regex(UUID, 'a tour is its export’s ID').optional(),
  })
  .transform((b) => ({ ...b, shows: b.shows ?? (b.tour === undefined ? { plan: true, threeD: true, findings: true } : NOTHING), comments: b.comments ?? b.tour === undefined }))
  .refine((b) => b.tour === undefined || (!b.shows.plan && !b.shows.threeD && !b.shows.findings && !b.comments), { path: ['tour'], message: 'a tour’s link shows the tour alone: no plan, 3D view, findings or comments' })
  .refine((b) => b.tour !== undefined || b.shows.plan || b.shows.threeD || b.shows.findings, { path: ['shows'], message: 'a link has to show something' })
  .refine((b) => !b.comments || b.shows.plan || b.shows.threeD, { path: ['comments'], message: 'comments are pinned to the plan or the 3D view: show one of them' });

/** A tour's file names, as the worker writes them (apps/worker tour/index.ts). */
const TOUR_FILE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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
      shows: { ...showsOf(link), tour: link.tourJobId !== null },
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

  /**
   * A texture of the shared version (FLR-T-9.6, FLR-T-9.1): only a file the version's document
   * names, and only one the project can reach (src/assets/access.ts) — a digest never reaches
   * anything else through a link. Headers as the owner's asset route (sandbox CSP, `nosniff`), but
   * revalidated every time like the model, so a revoked link stops at once.
   */
  routes.read('/:token/assets/:sha256', async (req, res) => {
    const { link, project } = shareOf(req);
    if (!link.showPlan && !link.show3d) throw new HttpError(404, 'this link does not share the model');
    const sha256 = String(req.params['sha256'] ?? '');
    if (!SHA256.test(sha256)) throw new HttpError(404, 'asset not found');
    const { document } = await documentOf(link);
    if (!digestsNamed(document).includes(sha256)) throw new HttpError(404, 'asset not found');
    const file = (await reachableFiles(db, project, document)).get(sha256);
    const bytes = file === undefined || deps.assets === undefined || deps.assets === null ? null : await deps.assets.get(sha256);
    if (file === undefined || bytes === null) throw new HttpError(404, 'asset not found');
    sendAssetBytes(req, res, file, bytes, 'private, no-cache');
  }, pub);

  /**
   * The tour a link shows (FLR-T-14.2): while its panoramas are made, how far it has got; once they
   * are, its manifest. Revalidated every time, like the model, so a revoked link stops at once.
   */
  routes.read('/:token/tour', async (req, res) => {
    const { link } = shareOf(req);
    if (link.tourJobId === null) throw new HttpError(404, 'this link does not share a tour');
    const job = await db.job.findUnique({ where: { id: link.tourJobId } });
    if (job === null) throw new HttpError(404, 'this link does not share a tour');
    const rooms = ((job.params as { rooms?: unknown } | null)?.rooms as unknown[] | undefined)?.length ?? 0;
    res.setHeader('Cache-Control', 'private, no-cache');
    if (job.status === 'failed') {
      res.status(200).json({ status: 'failed', panos: rooms, cancelled: (job.result as { cancelled?: unknown } | null)?.cancelled === true });
      return;
    }
    if (job.status !== 'done') {
      const p = (job.progress ?? {}) as { pano?: unknown; panos?: unknown };
      res.json({ status: job.status === 'running' ? 'rendering' : 'queued', panos: rooms, done: job.status === 'running' && typeof p.pano === 'number' ? Math.max(0, p.pano - 1) : 0 });
      return;
    }
    const output = await db.jobOutput.findUnique({ where: { jobId: job.id } });
    if (output === null) throw new HttpError(410, 'this tour’s panoramas are no longer kept');
    res.setHeader('ETag', `"${output.sha256}"`);
    if (req.get('if-none-match') === `"${output.sha256}"`) {
      res.status(304).end();
      return;
    }
    res.json({ status: 'done', panos: rooms, done: rooms, manifest: JSON.parse(Buffer.from(output.bytes).toString('utf8')) as unknown });
  }, pub);

  /** A panorama or a plan of the tour a link shows, by the name its manifest gives it. */
  routes.read('/:token/tour/:file', async (req, res) => {
    const { link } = shareOf(req);
    if (link.tourJobId === null) throw new HttpError(404, 'this link does not share a tour');
    const path = String(req.params['file'] ?? '');
    if (!TOUR_FILE.test(path)) throw new HttpError(404, 'no such file in this tour');
    const asset = await db.jobAsset.findUnique({ where: { jobId_path: { jobId: link.tourJobId, path } } });
    if (asset === null) throw new HttpError(404, 'no such file in this tour');
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('ETag', `"${asset.sha256}"`);
    // Asked again every time, so a revoked link stops at once; a 304 when it is unchanged.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (req.get('if-none-match') === `"${asset.sha256}"`) {
      res.status(304).end();
      return;
    }
    res.send(Buffer.from(asset.bytes));
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
    tour: link.tourJobId,
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
    // A tour's link (FLR-T-14.2): of a tour of this project's that is made or being made.
    if (body.tour !== undefined) {
      const job = await tx.job.findFirst({ where: { id: body.tour, projectId: project.id, kind: 'export.tour' } });
      if (job === null) throw new HttpError(404, 'tour not found');
      if (job.status === 'failed') throw new HttpError(409, 'this tour was not made: render it again, then share it');
    } else if (body.version === 'current') {
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
        tourJobId: body.tour ?? null,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + body.expiresInDays * 86_400_000),
      },
    });
    const events: ProjectEvent[] = [{ projectId: project.id, type: 'share', data: { id: link.id, change: 'created' } }];
    return {
      reply: (res) => res.status(201).json({ link: linkView(link), url: body.tour === undefined ? `${base}/s/${token}` : `${base}/s/${token}/tour`, token }),
      audit: {
        action: 'share.create',
        targetType: 'share_link',
        targetId: link.id,
        detail: { project: project.id, label: link.label, prefix: link.prefix, expiresAt: link.expiresAt, shows: showsOf(link), comments: link.allowComments, version: pin, ...(body.tour === undefined ? {} : { tour: body.tour }) },
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
