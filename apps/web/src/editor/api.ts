import type { Diagnostic } from '@floorspec/engine';
import type { Batch } from './ops';
import type { ImportReport } from '../exports/ifcImport';

/**
 * The editor's calls: read a version, apply a batch, undo and redo (FLR-T-2.4's routes). Writes
 * carry `If-Match` with the head the editor last read, so an edit made against a stale picture of
 * the model is refused (412) rather than applied to a model the person has not seen.
 */

export interface ProjectInfo {
  id: string;
  name: string;
  head: { name: string; version: string; updatedAt: string } | null;
  ops: number;
}

export type ApplyAnswer =
  | { status: 'committed'; hash: string; created: string[]; removed: string[]; seq: number }
  | { status: 'rejected'; diagnostics: Diagnostic[]; detail: string }
  | { status: 'stale'; hash: string | null }
  | { status: 'forbidden'; message: string }
  | { status: 'nothing'; message: string }
  | { status: 'failed'; message: string };

export interface History {
  head: string | null;
  undo: number | null;
  redo: number | null;
  /** The newest op on main, for the version label. */
  seq: number | null;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const messageOf = (body: Record<string, unknown>, status: number) =>
  typeof body['error'] === 'string' ? body['error'] : `the server answered ${String(status)}`;

export async function fetchProject(id: string, signal?: AbortSignal): Promise<ProjectInfo> {
  const res = await fetch(`/api/projects/${id}`, { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) });
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  return (await res.json()) as ProjectInfo;
}

export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

/** The head's canonical bytes, and its hash from the ETag. */
export async function fetchHead(projectId: string, signal?: AbortSignal): Promise<{ hash: string; text: string } | null> {
  const res = await fetch(`/api/projects/${projectId}/model.json`, { credentials: 'same-origin', cache: 'no-store', ...(signal === undefined ? {} : { signal }) });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  const etag = res.headers.get('etag') ?? '';
  return { hash: etag.replace(/^W\//, '').replace(/"/g, ''), text: await res.text() };
}

/** One version by hash: immutable, so the browser may keep it. */
export async function fetchVersion(projectId: string, hash: string): Promise<string> {
  const res = await fetch(`/api/projects/${projectId}/versions/${hash}`, { credentials: 'same-origin' });
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  return res.text();
}

export async function fetchHistory(projectId: string): Promise<History> {
  const res = await fetch(`/api/projects/${projectId}/history?limit=1`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  const body = (await res.json()) as { head: string | null; undo: number | null; redo: number | null; ops: { seq: number }[] };
  return { head: body.head, undo: body.undo, redo: body.redo, seq: body.ops[0]?.seq ?? null };
}

async function answer(res: Response): Promise<ApplyAnswer> {
  const body = await json(res);
  if (res.status === 201) {
    const op = body['op'] as { seq: number } | undefined;
    return {
      status: 'committed',
      hash: String(body['hash']),
      created: (body['created'] as string[] | undefined) ?? [],
      removed: (body['removed'] as string[] | undefined) ?? [],
      seq: op?.seq ?? 0,
    };
  }
  if (res.status === 422 && Array.isArray(body['diagnostics'])) {
    return { status: 'rejected', diagnostics: body['diagnostics'] as Diagnostic[], detail: typeof body['detail'] === 'string' ? body['detail'] : '' };
  }
  if (res.status === 412) return { status: 'stale', hash: typeof body['hash'] === 'string' ? body['hash'] : null };
  if (res.status === 401 || res.status === 403) return { status: 'forbidden', message: messageOf(body, res.status) };
  if (res.status === 409) return { status: 'nothing', message: messageOf(body, res.status) };
  return { status: 'failed', message: messageOf(body, res.status) };
}

function writeInit(head: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'if-match': `"${head}"` },
    body: JSON.stringify(body),
  };
}

/** Apply a batch to main — in `option`, a design option, when given (Ops 0.3, 2.8: `context.option`). */
export async function postBatch(projectId: string, head: string, batch: Batch, option?: string): Promise<ApplyAnswer> {
  try {
    return await answer(await fetch(`/api/projects/${projectId}/ops`, writeInit(head, { batch, ...(option === undefined ? {} : { context: { option } }) })));
  } catch {
    return { status: 'failed', message: 'The server did not answer. Nothing was changed.' };
  }
}

export async function postUndo(projectId: string, head: string, mode: 'undo' | 'redo'): Promise<ApplyAnswer> {
  try {
    return await answer(await fetch(`/api/projects/${projectId}/${mode}`, writeInit(head, {})));
  } catch {
    return { status: 'failed', message: 'The server did not answer. Nothing was changed.' };
  }
}

// ─── History (FLR-T-3.6) ─────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  seq: number;
  kind: 'create' | 'apply' | 'undo' | 'redo' | 'merge';
  author: { kind: 'account' | 'agent' | 'token'; account: string | null; name: string | null; token: string | null };
  ops: Record<string, unknown>[];
  /** The design option the batch was applied in (Ops 0.3, 2.8), or null. */
  option?: string | null;
  resolved: Record<string, unknown>[] | null;
  created: string[];
  removed: string[];
  before: string | null;
  after: string;
  undoOf: number | null;
  changeset: { id: string; name: string } | null;
  at: string;
}

export interface HistoryLog extends History {
  ops: HistoryEntry[];
}

export async function fetchHistoryLog(projectId: string, limit = 200): Promise<HistoryLog> {
  const res = await fetch(`/api/projects/${projectId}/history?limit=${String(limit)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  const body = (await res.json()) as { head: string | null; undo: number | null; redo: number | null; ops: HistoryEntry[] };
  return { head: body.head, undo: body.undo, redo: body.redo, seq: body.ops[0]?.seq ?? null, ops: body.ops };
}

/** The account's token names by ID, so the history can say which token wrote an op. */
export async function fetchTokenNames(): Promise<Map<string, string>> {
  const res = await fetch('/api/tokens', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) return new Map();
  const body = (await res.json()) as { tokens: { id: string; name: string }[] };
  return new Map(body.tokens.map((t) => [t.id, t.name]));
}

// ─── Changesets (FLR-T-3.5) ──────────────────────────────────────────────────────────────────

export interface ChangesetRow {
  id: string;
  name: string;
  status: 'pending' | 'accepted' | 'rejected';
  base: string;
  head: string | null;
  ops: number | null;
  createdBy: string | null;
  createdAt: string;
  fastForward: boolean | null;
}

export interface ChangesetLogEntry {
  seq: number;
  authorKind: 'account' | 'agent' | 'token';
  authorAgent: string | null;
  ops: Record<string, unknown>[];
  resolved: Record<string, unknown>[] | null;
  created: string[];
  removed: string[];
  beforeHash: string | null;
  afterHash: string;
  createdAt: string;
}

export interface ChangesetDetail extends ChangesetRow {
  main: string | null;
  log: ChangesetLogEntry[];
  /** An imported changeset's report of what did not come across (FLR-T-9.5); null otherwise. */
  report?: ImportReport | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  return (await res.json()) as T;
}

export async function fetchChangesets(projectId: string): Promise<ChangesetRow[]> {
  return (await getJson<{ changesets: ChangesetRow[] }>(`/api/projects/${projectId}/changesets`)).changesets;
}

export async function fetchChangeset(projectId: string, id: string): Promise<ChangesetDetail> {
  return getJson<ChangesetDetail>(`/api/projects/${projectId}/changesets/${id}`);
}

/** The scratch head's document, and its hash; null once the changeset is no longer pending. */
export async function fetchChangesetModel(projectId: string, id: string): Promise<{ hash: string; text: string } | null> {
  const res = await fetch(`/api/projects/${projectId}/changesets/${id}/model.json`, { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpFailure(res.status, messageOf(await json(res), res.status));
  return { hash: (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, ''), text: await res.text() };
}

export type DecideAnswer =
  | { status: 'accepted'; hash: string; mode: 'fast-forward' | 'replay' }
  | { status: 'rejected' }
  | { status: 'replay-failed'; detail: string; diagnostics: Diagnostic[]; failedIndex: number | null }
  | { status: 'stale' }
  | { status: 'failed'; message: string };

/** Accept (with `If-Match` on the main the person reviewed against) or reject a changeset. */
export async function decideChangeset(projectId: string, id: string, verb: 'accept' | 'reject', main?: string): Promise<DecideAnswer> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${projectId}/changesets/${id}/${verb}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(main === undefined ? {} : { 'if-match': `"${main}"` }) },
      body: '{}',
    });
  } catch {
    return { status: 'failed', message: 'The server did not answer. Nothing was changed.' };
  }
  const body = await json(res);
  if (res.ok) return verb === 'accept' ? { status: 'accepted', hash: String(body['hash']), mode: body['mode'] === 'replay' ? 'replay' : 'fast-forward' } : { status: 'rejected' };
  if (res.status === 409 && Array.isArray(body['diagnostics'])) {
    return {
      status: 'replay-failed',
      detail: typeof body['detail'] === 'string' ? body['detail'] : 'The changeset no longer applies to main.',
      diagnostics: body['diagnostics'] as Diagnostic[],
      failedIndex: typeof body['failedIndex'] === 'number' ? body['failedIndex'] : null,
    };
  }
  if (res.status === 412) return { status: 'stale' };
  return { status: 'failed', message: messageOf(body, res.status) };
}

/** Who opened a changeset, for a person to read: an agent's name, or "You" for a session's or token's own. */
export function proposerOf(createdBy: string | null | undefined): string {
  if (createdBy === null || createdBy === undefined || createdBy === '') return 'An agent';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(createdBy)) return 'You';
  if (createdBy.startsWith('token:')) return 'A token';
  return createdBy;
}
