import type { Db, Tx } from '../db.js';
import type { Comment } from '../generated/prisma/client.js';
import type { CommentEventData, ProjectEvent } from '../events/types.js';

/**
 * Comments on a shared project (FLR-T-9.6, FLR-REQ-134, FLR-REQ-167). A thread's root is pinned to
 * an element; replies hang off it. Text is **markdown-lite** — `**bold**`, `*italic*`, `` `code` ``
 * and line breaks, nothing else — stored as the plain text the person typed, cleaned here and
 * rendered by the browser as text nodes. No HTML is ever produced from it, on either side.
 */

export const MAX_BODY = 4000;

/**
 * C0 controls but tab and newline, DEL, the zero-width characters and the bidirectional overrides
 * and isolates — the characters that make text read differently from what it says ("Trojan Source").
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Clean a comment's text: newlines normalised, unsafe characters dropped, at most one blank line in a row. */
export function cleanBody(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Named = Comment & { author: { displayName: string }; resolvedBy: { displayName: string } | null; shareLink?: { id: string; label: string | null; prefix: string } | null };

export interface CommentView {
  id: string;
  parent: string | null;
  author: { name: string; you: boolean; owner: boolean };
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  /** A thread's root only. */
  pin: { element: string; level: string; version: string; point: [number, number] | null } | null;
  resolved: { at: Date; by: string | null } | null;
  /** The owner's view only: the link the thread came through. */
  link?: { id: string; label: string | null; prefix: string } | null;
}

export interface ThreadView extends CommentView {
  replies: CommentView[];
}

function view(c: Named, you: string | null, owner: string, withLink: boolean): CommentView {
  return {
    id: c.id,
    parent: c.parentId,
    // Names only: no account ID, and never an email, reaches a viewer.
    author: { name: c.author.displayName, you: you !== null && c.authorAccountId === you, owner: c.authorAccountId === owner },
    body: c.deletedAt === null ? c.body : '',
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    deleted: c.deletedAt !== null,
    pin:
      c.parentId === null && c.elementId !== null && c.levelId !== null
        ? { element: c.elementId, level: c.levelId, version: c.versionHash, point: c.pointX === null || c.pointY === null ? null : [c.pointX, c.pointY] }
        : null,
    resolved: c.resolvedAt === null ? null : { at: c.resolvedAt, by: c.resolvedBy?.displayName ?? null },
    ...(withLink ? { link: c.shareLink ?? null } : {}),
  };
}

/**
 * The threads a reader may see, oldest first: every thread of the project for its owner, or the
 * threads made through one link for that link's viewers. A deleted root with no living reply is
 * gone; with replies it stays, blank, so the conversation still reads.
 */
export async function threadsOf(
  db: Db | Tx,
  scope: { projectId: string; linkId?: string },
  reader: { you: string | null; owner: string; withLink: boolean },
): Promise<ThreadView[]> {
  const rows = await db.comment.findMany({
    where: { projectId: scope.projectId, ...(scope.linkId === undefined ? {} : { shareLinkId: scope.linkId }) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 5000,
    include: {
      author: { select: { displayName: true } },
      resolvedBy: { select: { displayName: true } },
      ...(reader.withLink ? { shareLink: { select: { id: true, label: true, prefix: true } } } : {}),
    },
  });
  const roots = new Map<string, ThreadView>();
  for (const row of rows) if (row.parentId === null) roots.set(row.id, { ...view(row, reader.you, reader.owner, reader.withLink), replies: [] });
  for (const row of rows) {
    if (row.parentId === null || row.deletedAt !== null) continue;
    roots.get(row.parentId)?.replies.push(view(row, reader.you, reader.owner, reader.withLink));
  }
  return [...roots.values()].filter((t) => !t.deleted || t.replies.length > 0);
}

/** The live stream's news of a comment: never its text. */
export function commentEvent(comment: Pick<Comment, 'id' | 'parentId' | 'projectId' | 'shareLinkId'>, change: CommentEventData['change']): ProjectEvent {
  return {
    projectId: comment.projectId,
    type: 'comment',
    data: { id: comment.id, thread: comment.parentId ?? comment.id, link: comment.shareLinkId, change },
  };
}
