import type { Diagnostic } from '@floorspec/engine';
import type { Batch } from './ops';

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

export async function postBatch(projectId: string, head: string, batch: Batch): Promise<ApplyAnswer> {
  try {
    return await answer(await fetch(`/api/projects/${projectId}/ops`, writeInit(head, { batch })));
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
