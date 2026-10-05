import type { Diagnostic } from '@floorspec/engine';
import { INVERSE_ORDER, type Operation } from '@floorspec/ops';
import { api } from '../lib/api';

/**
 * A project that starts from a whole document — a template, or an imported file — is created blank
 * and then given the document as one batch of Floorspec Ops (FLR-ADR-008): an `addElement` for
 * every element, and `setProperty $document` for the rest. Nothing writes the document directly,
 * and the project's history begins with the import as an op like any other.
 */

type Json = Record<string, unknown>;

/** The members of `$document` other than the collections and the version (Ops 2.3). */
const DOCUMENT_MEMBERS = ['site', 'extensionsUsed', 'extensionsRequired', 'extensions', 'extras'] as const;

/** The batch that turns the empty document named `name` into `document` (named `name`). */
export function documentToBatch(document: Json, name: string): Operation[] {
  const batch: Operation[] = [];
  // Declarations first, so extension data on elements names a used extension (FS-INV-005) — though
  // only the end state is judged, this is the order a reader expects in the log.
  for (const member of DOCUMENT_MEMBERS) {
    const value = document[member];
    if (value !== undefined) batch.push({ op: 'setProperty', id: '$document', path: `/${member}`, value });
  }
  const project = document['project'] as Json | undefined;
  for (const [key, value] of Object.entries(project ?? {})) {
    if (key !== 'name') batch.push({ op: 'setProperty', id: '$project', path: `/${key}`, value });
  }
  if (project?.['name'] !== name) batch.push({ op: 'setProperty', id: '$project', path: '/name', value: name });
  // Elements in the reverse of the inverse's removal order: what is referred to before what refers.
  for (const collection of [...INVERSE_ORDER].reverse()) {
    const elements = document[collection] as Record<string, Json | undefined> | undefined;
    for (const [id, element] of Object.entries(elements ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (element !== undefined) batch.push({ op: 'addElement', collection, id, element });
    }
  }
  return batch;
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
