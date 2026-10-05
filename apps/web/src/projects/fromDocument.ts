import type { Diagnostic } from '@floorspec/engine';
import type { Operation } from '@floorspec/ops';
import { documentToBatch as toBatch } from '@floorspec/package';
import { api } from '../lib/api';

/**
 * A project that starts from a whole document — a template, or an imported file — is created blank
 * and then given the document as one batch of Floorspec Ops (FLR-ADR-008): an `addElement` for
 * every element, and `setProperty $document` for the rest. Nothing writes the document directly,
 * and the project's history begins with the import as an op like any other.
 */

type Json = Record<string, unknown>;

/** The Core version a new project starts at (the server's FLOORSPEC_VERSION). */
const FLOORSPEC_VERSION = '0.3';

/**
 * The batch that turns the empty document named `name` into `document` (named `name`). It lives in
 * @floorspec/package now (FLR-T-9.1), so the server's package import builds the very same batch.
 */
export function documentToBatch(document: Json, name: string): Operation[] {
  return toBatch(document, name, { from: FLOORSPEC_VERSION }) as unknown as Operation[];
}

export type CreateOutcome = { status: 'created'; id: string } | { status: 'rejected'; diagnostics: Diagnostic[] } | { status: 'failed'; message: string };

/** Create a project and apply the document to it; a project whose batch is refused is removed again. */
export async function createFromDocument(name: string, document: Json): Promise<CreateOutcome> {
  const created = await api.post<{ id: string; head: string }>('/api/projects', { name });
  const batch = documentToBatch(document, name);
  if (batch.length === 0) return { status: 'created', id: created.id };
  const res = await fetch(`/api/projects/${created.id}/ops`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'if-match': `"${created.head}"` },
    body: JSON.stringify({ batch }),
  });
  if (res.status === 201) return { status: 'created', id: created.id };
  const body = (await res.json().catch(() => ({}))) as { diagnostics?: Diagnostic[]; error?: string };
  // Nothing of the document was stored; the empty project is not what was asked for.
  await api.del(`/api/projects/${created.id}`).catch(() => undefined);
  if (Array.isArray(body.diagnostics)) return { status: 'rejected', diagnostics: body.diagnostics };
  return { status: 'failed', message: body.error ?? `The server answered ${String(res.status)}.` };
}
