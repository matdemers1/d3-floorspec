import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Tx } from '../db.js';
import type { Project, ShareLink } from '../generated/prisma/client.js';
import { hashToken } from '../auth/sessions.js';
import { MAIN } from '../domain/projects.js';

/**
 * Share links (FLR-T-9.6, FLR-REQ-133). The token is 32 random bytes, base64url — 43 characters,
 * 256 bits — and only its SHA-256 is stored: the URL is shown to the owner once, as an API token's
 * secret is. It is **not** a credential in any other sense: `attachAuth` never reads it, so it can
 * never stand for an account or reach a route outside `/api/share/:token/*`, and it resolves to one
 * project and the version and views the link names, nothing more.
 */

/** The shape of a share token: anything else is refused before the database is asked. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Characters of the token kept for the owner's list, so two links can be told apart (36 of 256 bits). */
export const PREFIX_LENGTH = 6;

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;
/** Live links per project; more is a mistake, or somebody scripting the dialog. */
export const MAX_ACTIVE_LINKS = 50;

export function mintShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export type Gone = 'expired' | 'revoked';

/** The link a token names, with the project and the owner's display name; never the owner's email. */
export interface ResolvedShare {
  readonly link: ShareLink;
  readonly project: Project;
  readonly ownerName: string;
}

export type Resolution = { status: 'ok'; share: ResolvedShare } | { status: 'gone'; reason: Gone } | { status: 'missing' };

/**
 * Resolve a presented token. A token of the wrong shape, an unknown one, a deleted project and an
 * owner whose account is disabled are all `missing`; an expired or revoked link is `gone`, so the
 * person holding it is told why it stopped working rather than that it never did.
 */
export async function resolveShare(db: Db, presented: string, now = Date.now()): Promise<Resolution> {
  if (!SHARE_TOKEN.test(presented)) return { status: 'missing' };
  const tokenHash = hashToken(presented);
  const link = await db.shareLink.findUnique({
    where: { tokenHash },
    include: { project: { include: { owner: { select: { displayName: true, disabledAt: true } } } } },
  });
  if (link === null) return { status: 'missing' };
  // The lookup was by hash; comparing again in constant time costs nothing and closes the argument.
  if (!timingSafeEqual(Buffer.from(link.tokenHash), Buffer.from(tokenHash))) return { status: 'missing' };
  const { project, ...row } = link;
  const { owner, ...bare } = project;
  if (bare.deletedAt !== null || owner.disabledAt !== null || bare.ownerAccountId !== row.createdByAccountId) return { status: 'missing' };
  if (row.revokedAt !== null) return { status: 'gone', reason: 'revoked' };
  if (row.expiresAt.getTime() <= now) return { status: 'gone', reason: 'expired' };
  return { status: 'ok', share: { link: row, project: bare, ownerName: owner.displayName } };
}

/** The version a link shows now: its pin, or main's head and the number of the newest op on main. */
export async function sharedVersion(db: Db | Tx, link: Pick<ShareLink, 'projectId' | 'versionHash' | 'versionSeq'>): Promise<{ hash: string; seq: number | null; pinned: boolean } | null> {
  if (link.versionHash !== null) return { hash: link.versionHash, seq: link.versionSeq, pinned: true };
  const [head, newest] = await Promise.all([
    db.head.findUnique({ where: { projectId_name: { projectId: link.projectId, name: MAIN } } }),
    db.opLog.findFirst({ where: { projectId: link.projectId, head: MAIN }, orderBy: { seq: 'desc' }, select: { seq: true } }),
  ]);
  if (head === null) return null;
  return { hash: head.versionHash, seq: newest?.seq ?? null, pinned: false };
}

export type LinkState = 'active' | 'expired' | 'revoked';

export function stateOf(link: Pick<ShareLink, 'revokedAt' | 'expiresAt'>, now = Date.now()): LinkState {
  if (link.revokedAt !== null) return 'revoked';
  return link.expiresAt.getTime() <= now ? 'expired' : 'active';
}

/** What a link shows, as the API spells it. */
export function showsOf(link: Pick<ShareLink, 'showPlan' | 'show3d' | 'showFindings'>): { plan: boolean; threeD: boolean; findings: boolean } {
  return { plan: link.showPlan, threeD: link.show3d, findings: link.showFindings };
}

/**
 * Every element a comment may be pinned to in a document (FLR-REQ-167): what is drawn on a plan —
 * walls, openings, rooms, separators, slabs, roofs, stairs, junctions — and every extension
 * element (a receptacle, a fixture). Levels, types and materials are not places on a plan.
 */
const PINNABLE = ['junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'roofs', 'stairs'] as const;

export function hasElement(document: unknown, id: string): boolean {
  if (typeof document !== 'object' || document === null) return false;
  const doc = document as Record<string, unknown>;
  const holds = (collection: unknown) =>
    typeof collection === 'object' && collection !== null && !Array.isArray(collection) && Object.hasOwn(collection, id);
  if (PINNABLE.some((name) => holds(doc[name]))) return true;
  const extensions = doc['extensions'];
  if (typeof extensions !== 'object' || extensions === null) return false;
  return Object.values(extensions as Record<string, unknown>).some(
    (extension) => typeof extension === 'object' && extension !== null && Object.values(extension as Record<string, unknown>).some(holds),
  );
}

export function hasLevel(document: unknown, id: string): boolean {
  const levels = (document as { levels?: unknown } | null)?.levels;
  return typeof levels === 'object' && levels !== null && Object.hasOwn(levels, id);
}
