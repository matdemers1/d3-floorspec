import { api, ApiError } from '../lib/api';

/**
 * The calls sharing makes (FLR-T-9.6): the owner's links and comments under the project, and what a
 * share link reaches under `/api/share/<token>`. Same origin, so the session cookie travels on its
 * own — and only a signed-in person's comment writes use it.
 */

// ─── Links (the owner's) ─────────────────────────────────────────────────────────────────────

export interface Shows {
  plan: boolean;
  threeD: boolean;
  findings: boolean;
}

export interface ShareLinkRow {
  id: string;
  label: string | null;
  prefix: string;
  shows: Shows;
  comments: boolean;
  version: { pinned: boolean; hash: string | null; seq: number | null };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  views: number;
  commentCount: number;
  state: 'active' | 'expired' | 'revoked';
}

export interface NewShare {
  label?: string;
  expiresInDays: number;
  version: 'latest' | 'current';
  shows: Shows;
  comments: boolean;
}

export const listShares = async (projectId: string) => (await api.get<{ links: ShareLinkRow[] }>(`/api/projects/${projectId}/shares`)).links;
export const createShare = (projectId: string, body: NewShare) => api.post<{ link: ShareLinkRow; url: string }>(`/api/projects/${projectId}/shares`, body);
export const revokeShare = (projectId: string, id: string) => api.del(`/api/projects/${projectId}/shares/${id}`);

// ─── Comments ────────────────────────────────────────────────────────────────────────────────

export interface CommentView {
  id: string;
  parent: string | null;
  author: { name: string; you: boolean; owner: boolean };
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pin: { element: string; level: string; version: string; point: [number, number] | null } | null;
  resolved: { at: string; by: string | null } | null;
  /** The owner's view: the link the thread came through. */
  link?: { id: string; label: string | null; prefix: string } | null;
}

export interface Thread extends CommentView {
  replies: CommentView[];
}

/** Where comments are read and written: through a share link, or as the project's owner. */
export interface CommentsEndpoint {
  /** Lists threads. */
  readonly list: string;
  /** Starts a thread; absent where a thread cannot be started (the owner answers from the editor). */
  readonly create?: string;
  readonly replies: (id: string) => string;
  readonly comment: (id: string) => string;
  /** The owner's alone. */
  readonly resolve?: (id: string, verb: 'resolve' | 'reopen') => string;
  /** The live stream. */
  readonly events: string;
}

export function shareEndpoint(token: string): CommentsEndpoint {
  const base = `/api/share/${encodeURIComponent(token)}`;
  return {
    list: `${base}/comments`,
    create: `${base}/comments`,
    replies: (id) => `${base}/comments/${id}/replies`,
    comment: (id) => `${base}/comments/${id}`,
    events: `${base}/events`,
  };
}

export function ownerEndpoint(projectId: string): CommentsEndpoint {
  const base = `/api/projects/${projectId}`;
  return {
    list: `${base}/comments`,
    replies: (id) => `${base}/comments/${id}/replies`,
    comment: (id) => `${base}/comments/${id}`,
    resolve: (id, verb) => `${base}/comments/${id}/${verb}`,
    events: `${base}/comments/events`,
  };
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  const parsed: unknown = text === '' ? undefined : JSON.parse(text);
  if (!res.ok) throw new ApiError(res.status, typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String(parsed.error) : `request failed with ${String(res.status)}`, parsed);
  return parsed as T;
}

// ─── What a share link reaches ───────────────────────────────────────────────────────────────

export interface ShareMeta {
  project: { name: string };
  sharedBy: string;
  version: { hash: string; seq: number | null; pinned: boolean } | null;
  shows: Shows;
  comments: { allowed: boolean; signedIn: boolean; you: { name: string } | null; owner: boolean };
  expiresAt: string;
}

export type MetaAnswer = { status: 'ok'; meta: ShareMeta } | { status: 'gone'; reason: 'expired' | 'revoked' } | { status: 'missing' } | { status: 'limited' } | { status: 'failed'; message: string };

export async function fetchMeta(token: string): Promise<MetaAnswer> {
  try {
    return { status: 'ok', meta: await api.get<ShareMeta>(`/api/share/${encodeURIComponent(token)}`) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { status: 'missing' };
      if (error.status === 410) return { status: 'gone', reason: (error.body as { reason?: string } | undefined)?.reason === 'expired' ? 'expired' : 'revoked' };
      if (error.status === 429) return { status: 'limited' };
      return { status: 'failed', message: error.message };
    }
    return { status: 'failed', message: 'The server did not answer.' };
  }
}

export async function fetchSharedModel(token: string): Promise<{ hash: string; text: string }> {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}/model.json`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, `the model did not load (${String(res.status)})`);
  return { hash: (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, ''), text: await res.text() };
}
