import type { Db, Tx } from '../db.js';
import type { Changeset, OpLog } from '../generated/prisma/client.js';
import { MAIN } from '../domain/projects.js';
import { changesetHead } from '../domain/history.js';
import { CHANNEL, type ChangesetChange, type ChangesetEventData, type HeadEventData, type ProjectEvent } from './types.js';

/**
 * Publishing (FLR-T-3.5). An event goes out as `pg_notify('floorspec_events', <json>)`, and every
 * api process's listener fans it out to its own subscribers.
 *
 * **Inside the transaction that made the change.** Postgres holds a transaction's notifications
 * until it commits, delivers them only if it does, and delivers them in commit order: so an event
 * never precedes its commit, a rejected batch (a rolled-back transaction) publishes nothing by
 * construction, two commits to one project arrive in the order they were made, and a process that
 * dies between commit and publish loses nothing — none of which a NOTIFY sent after the commit, on
 * another connection, could promise.
 */

/** The wire envelope. Short keys: a NOTIFY payload is capped below 8000 bytes. */
export interface Envelope {
  readonly v: 1;
  readonly p: string;
  readonly t: ProjectEvent['type'];
  readonly d: unknown;
}

/** Postgres refuses a payload of 8000 bytes or more; stay well inside it. */
export const MAX_PAYLOAD = 7_500;

export function encode(event: ProjectEvent): string {
  const payload = JSON.stringify({ v: 1, p: event.projectId, t: event.type, d: event.data } satisfies Envelope);
  // Nothing an event carries is unbounded (names are at most 120 characters), but a payload that
  // did not fit would fail the commit it describes. Refuse it here, loudly, instead.
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD) throw new Error(`a ${event.type} event is too large to NOTIFY`);
  return payload;
}

/** Queue events on the transaction: delivered when, and only if, it commits. */
export async function publishInTx(tx: Tx, events: readonly ProjectEvent[]): Promise<void> {
  for (const event of events) {
    await tx.$executeRaw`select pg_notify(${CHANNEL}, ${encode(event)})`;
  }
}

/**
 * Publish outside any transaction — for news that a transaction rolled back (a replay that failed),
 * sent after the rollback.
 */
export async function publishNow(db: Db, events: readonly ProjectEvent[]): Promise<void> {
  for (const event of events) {
    await db.$executeRaw`select pg_notify(${CHANNEL}, ${encode(event)})`;
  }
}

/** Who an op is attributed to, in the same shape as a changeset's `createdBy`. */
function authorName(op: Pick<OpLog, 'authorAgent' | 'authorTokenId' | 'authorAccountId'>): string {
  return op.authorAgent ?? (op.authorTokenId !== null ? `token:${op.authorTokenId}` : op.authorAccountId ?? 'unknown');
}

/** Main moved to `op.afterHash`. */
export function headEvent(projectId: string, op: OpLog): ProjectEvent {
  const data: HeadEventData = {
    head: MAIN,
    hash: op.afterHash,
    seq: op.seq,
    kind: op.kind,
    authorKind: op.authorKind,
    author: authorName(op),
    changeset: op.changesetId,
  };
  return { projectId, type: 'head', data };
}

export function changesetCreatedBy(changeset: Changeset): string {
  return changeset.createdByAgent ?? (changeset.createdByTokenId !== null ? `token:${changeset.createdByTokenId}` : changeset.createdByAccountId ?? 'unknown');
}

/** A changeset changed. `ops` is counted by the caller, inside the same transaction. */
export function changesetEvent(changeset: Changeset, change: ChangesetChange, input: { hash: string | null; ops: number }): ProjectEvent {
  const data: ChangesetEventData = {
    id: changeset.id,
    name: changeset.name,
    status: changeset.status,
    change,
    head: changesetHead(changeset.id),
    hash: input.hash,
    base: changeset.baseHash,
    ops: input.ops,
    createdBy: changesetCreatedBy(changeset),
    mergeMode: changeset.mergeMode === null ? null : changeset.mergeMode === 'fast_forward' ? 'fast-forward' : 'replay',
  };
  return { projectId: changeset.projectId, type: 'changeset', data };
}

/** The number of batches recorded on a changeset's scratch head. */
export function countChangesetOps(tx: Tx, changeset: Pick<Changeset, 'id' | 'projectId'>): Promise<number> {
  return tx.opLog.count({ where: { projectId: changeset.projectId, changesetId: changeset.id, head: changesetHead(changeset.id) } });
}

/**
 * Events that must go out even though the request's transaction rolls back — attached to the error
 * that rolls it back, and published by `Routes.mutate` once the rollback is done.
 */
export class WithEvents extends Error {
  constructor(
    readonly error: unknown,
    readonly events: readonly ProjectEvent[],
  ) {
    super(error instanceof Error ? error.message : 'request failed');
    this.name = 'WithEvents';
  }
}
