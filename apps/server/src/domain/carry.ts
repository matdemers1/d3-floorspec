import type { Tx } from '../db.js';
import type { Changeset, OpLog } from '../generated/prisma/client.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import type { Applier, Batch } from '../ops/applier.js';
import { applyToHead, changesetHead, readHead, type ApplyOutcome, type Author, type HeadState } from './history.js';

/**
 * A pending changeset an assistant or the layout solver reads instead of main (FLR-T-12.13,
 * FLR-T-12.17). An agent's whole plan is in its changeset — it never writes main (FLR-ADR-016) — so
 * what is proposed from it is opened as a changeset that carries the source's operations ahead of
 * its own: accepting it brings both in.
 */
export interface Source {
  readonly changeset: Changeset;
  /** The source's head: the document to read. */
  readonly head: HeadState;
  /** Its op log, oldest first: what a proposal from it carries. */
  readonly ops: readonly OpLog[];
}

/**
 * The pending changeset `handle` names (ID or name), with its head and op log. It must still start
 * from main as main is now, or what is proposed from it could not be accepted as it stands: 409.
 */
export async function readSource(tx: Tx, projectId: string, handle: string, mainHash: string, what: string): Promise<Source> {
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle);
  const changeset = await tx.changeset.findFirst({ where: { projectId, status: 'pending', ...(byId ? { id: handle.toLowerCase() } : { name: handle }) } });
  if (changeset === null) throw new HttpError(404, `no pending changeset "${handle}" holds ${what} here`);
  if (changeset.baseHash !== mainHash) {
    throw new ProblemError({
      status: 409,
      type: 'source-stale',
      title: 'the changeset no longer starts from main',
      detail: `Main has moved since "${changeset.name}" was opened, so what is proposed from it could not be accepted as it stands. Accept or reject "${changeset.name}" first, or write it again.`,
      changeset: changeset.id,
    });
  }
  const head = await readHead(tx, projectId, changesetHead(changeset.id));
  const ops = await tx.opLog.findMany({ where: { projectId, head: changesetHead(changeset.id) }, orderBy: { seq: 'asc' } });
  return { changeset, head, ops };
}

/**
 * Apply the source's operations to a new changeset's head, as they resolved — so the IDs the
 * proposal names are the source's — before its own. The source claimed those IDs first; they are
 * its to give. A refusal is handed back for the caller to report; null when everything applied.
 */
export async function carry(tx: Tx, applier: Applier, input: { projectId: string; head: string; changesetId: string; source: Source; author: Author }): Promise<Extract<ApplyOutcome, { status: 'rejected' }> | null> {
  for (const op of input.source.ops) {
    const batch = (op.resolved ?? op.ops) as unknown as Batch;
    const copied = await applyToHead(tx, applier, {
      projectId: input.projectId,
      head: input.head,
      batch,
      author: input.author,
      kind: 'apply',
      changesetId: input.changesetId,
      retiredExcept: { changesetId: input.source.changeset.id },
    });
    if (copied.status === 'rejected') return copied;
  }
  return null;
}
