import type { Tx } from '../db.js';
import type { Changeset, OpLog } from '../generated/prisma/client.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import type { Applier, Batch, Committed } from '../ops/applier.js';
import { documentOf } from '../ops/applier.js';
import { storeVersion, MAIN } from './projects.js';
import {
  appendOp,
  changesetHead,
  checkIfMatch,
  lockProject,
  moveHead,
  readHead,
  retire,
  retiredFor,
  runApplier,
  type Author,
} from './history.js';

/**
 * Changesets (FLR-T-2.5, FLR-ADR-016): agents propose, people dispose.
 *
 * An agent's ops land on a scratch head `cs/<id>` that starts at main's head when the changeset
 * opens. Accepting it:
 *   - **fast-forwards** when main has not moved since — the changeset's ops are appended to main's
 *     log exactly as they were recorded, and main moves to the scratch head's version;
 *   - otherwise **replays** the changeset's original batches, references and all, onto the current
 *     main — the semantic replay, so "the north wall of the Kitchen" is resolved again against the
 *     plan as it is now. A batch that no longer applies stops the accept: nothing is merged, the
 *     changeset stays pending, and the applier's diagnostics say why.
 * Rejecting discards the scratch head. Either way the changeset row and its ops stay in the log.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_CHANGESET_NAME = 120;

/** A pending changeset by handle (its ID) or by name, or — given a name — a new one. */
export async function openChangeset(
  tx: Tx,
  projectId: string,
  handleOrName: string,
  author: Author,
): Promise<{ changeset: Changeset; opened: boolean }> {
  const trimmed = handleOrName.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CHANGESET_NAME) {
    throw new HttpError(400, `a changeset needs a name of 1 to ${String(MAX_CHANGESET_NAME)} characters`);
  }
  if (UUID.test(trimmed)) {
    const byId = await tx.changeset.findFirst({ where: { id: trimmed.toLowerCase(), projectId } });
    if (byId === null) throw new HttpError(404, 'changeset not found');
    if (byId.status !== 'pending') throw new HttpError(409, `that changeset was ${byId.status} and takes no more ops`);
    return { changeset: byId, opened: false };
  }
  const byName = await tx.changeset.findFirst({ where: { projectId, name: trimmed, status: 'pending' } });
  if (byName !== null) return { changeset: byName, opened: false };

  const main = await readHead(tx, projectId, MAIN);
  const changeset = await tx.changeset.create({
    data: {
      projectId,
      name: trimmed,
      baseHash: main.hash,
      createdByAccountId: author.accountId,
      createdByTokenId: author.tokenId,
      createdByAgent: author.agent,
    },
  });
  await moveHead(tx, projectId, changesetHead(changeset.id), main.hash);
  return { changeset, opened: true };
}

export async function pendingChangeset(tx: Tx, projectId: string, changesetId: string): Promise<Changeset> {
  if (!UUID.test(changesetId)) throw new HttpError(404, 'changeset not found');
  const changeset = await tx.changeset.findFirst({ where: { id: changesetId, projectId } });
  if (changeset === null) throw new HttpError(404, 'changeset not found');
  if (changeset.status !== 'pending') throw new HttpError(409, `that changeset was already ${changeset.status}`);
  return changeset;
}

export interface AcceptOutcome {
  readonly mode: 'fast_forward' | 'replay';
  readonly hash: string;
  readonly ops: readonly OpLog[];
}

/**
 * Accept a changeset onto main. The caller holds no lock yet; this takes the project's. A replay
 * that fails throws a 409 problem carrying the applier's diagnostics, before anything is written.
 */
export async function acceptChangeset(
  tx: Tx,
  applier: Applier,
  input: { projectId: string; changesetId: string; acceptedBy: string; ifMatch?: string | undefined },
): Promise<AcceptOutcome> {
  await lockProject(tx, input.projectId);
  const changeset = await pendingChangeset(tx, input.projectId, input.changesetId);
  const main = await readHead(tx, input.projectId, MAIN);
  checkIfMatch(input.ifMatch, main);
  const scratch = await readHead(tx, input.projectId, changesetHead(changeset.id));
  const ops = await tx.opLog.findMany({
    where: { projectId: input.projectId, head: changesetHead(changeset.id) },
    orderBy: { seq: 'asc' },
  });

  const mode = main.hash === changeset.baseHash ? 'fast_forward' : 'replay';
  const merged: OpLog[] = [];

  if (mode === 'fast_forward') {
    // Main is where the changeset started, so the changeset's own results are main's next results:
    // its ops chain from main's head to the scratch head's version without applying anything again.
    for (const op of ops) {
      merged.push(
        await appendOp(tx, {
          projectId: input.projectId,
          head: MAIN,
          kind: 'merge',
          author: authorOfOp(op),
          batch: op.ops as unknown as Batch,
          resolved: op.resolved as unknown as Batch | null,
          inverse: op.inverse as unknown as Batch | null,
          created: op.created,
          removed: op.removed,
          before: op.beforeHash,
          after: op.afterHash,
          changesetId: changeset.id,
          undoOfId: null,
        }),
      );
    }
    await moveHead(tx, input.projectId, MAIN, scratch.hash);
  } else {
    // Replay every batch as it was sent, in order, against main as it is now. Everything is applied
    // in memory first; nothing is written until the last batch has committed.
    const retired = await retiredFor(tx, input.projectId, { changesetId: changeset.id });
    let document: unknown = main.document;
    let before = main.hash;
    const results: { op: OpLog; result: Committed; before: string }[] = [];
    for (const [index, op] of ops.entries()) {
      const batch = op.ops as unknown as Batch;
      const result = runApplier(applier, document, batch, [...retired, ...results.flatMap((r) => r.result.created)]);
      if (result.status === 'rejected') {
        throw new ProblemError({
          status: 409,
          type: 'replay-failed',
          title: 'the changeset no longer applies to main',
          detail:
            `Main has moved since "${changeset.name}" was proposed, and batch ${String(index + 1)} of ${String(ops.length)} ` +
            `(op ${String(op.seq)}) was rejected when replayed onto it. Nothing was merged; the changeset is still pending.`,
          changeset: changeset.id,
          failedOp: op.seq,
          failedIndex: index,
          diagnostics: result.diagnostics,
        });
      }
      results.push({ op, result, before });
      document = documentOf(result);
      before = result.hash;
    }
    for (const { op, result, before: from } of results) {
      const hash = await storeVersion(tx, documentOf(result) as never);
      if (hash !== result.hash) throw new Error(`the applier reported ${result.hash} but the document hashes to ${hash}`);
      merged.push(
        await appendOp(tx, {
          projectId: input.projectId,
          head: MAIN,
          kind: 'merge',
          author: authorOfOp(op),
          batch: op.ops as unknown as Batch,
          resolved: result.resolved,
          inverse: result.inverse,
          created: result.created,
          removed: result.removed,
          before: from,
          after: hash,
          changesetId: changeset.id,
          undoOfId: null,
        }),
      );
      await retire(tx, input.projectId, [...result.created, ...result.removed], null);
    }
    await moveHead(tx, input.projectId, MAIN, before);
  }

  const hash = mode === 'fast_forward' ? scratch.hash : merged.at(-1)?.afterHash ?? main.hash;
  await closeChangeset(tx, changeset.id, {
    status: 'accepted',
    closedByAccountId: input.acceptedBy,
    mergeMode: mode,
    mergedHash: hash,
  });
  return { mode, hash, ops: merged };
}

export async function rejectChangeset(tx: Tx, input: { projectId: string; changesetId: string; rejectedBy: string }): Promise<Changeset> {
  await lockProject(tx, input.projectId);
  const changeset = await pendingChangeset(tx, input.projectId, input.changesetId);
  return closeChangeset(tx, changeset.id, { status: 'rejected', closedByAccountId: input.rejectedBy, mergeMode: null, mergedHash: null });
}

/** Close a changeset and discard its scratch head; its ops stay in the log. */
async function closeChangeset(
  tx: Tx,
  changesetId: string,
  close: { status: 'accepted' | 'rejected'; closedByAccountId: string; mergeMode: 'fast_forward' | 'replay' | null; mergedHash: string | null },
): Promise<Changeset> {
  const changeset = await tx.changeset.update({
    where: { id: changesetId },
    data: { status: close.status, closedAt: new Date(), closedByAccountId: close.closedByAccountId, mergeMode: close.mergeMode, mergedHash: close.mergedHash },
  });
  await tx.head.deleteMany({ where: { projectId: changeset.projectId, name: changesetHead(changesetId) } });
  return changeset;
}

/** The author an op was recorded with, carried onto main when it is merged. */
function authorOfOp(op: OpLog): Author {
  return { kind: op.authorKind, accountId: op.authorAccountId, agent: op.authorAgent, tokenId: op.authorTokenId };
}

/** The public shape of a changeset. */
export function changesetView(changeset: Changeset, extra: { head?: string | null; ops?: number } = {}) {
  return {
    id: changeset.id,
    name: changeset.name,
    status: changeset.status,
    base: changeset.baseHash,
    head: extra.head ?? null,
    ops: extra.ops ?? null,
    createdBy: changeset.createdByAgent ?? (changeset.createdByTokenId !== null ? `token:${changeset.createdByTokenId}` : changeset.createdByAccountId),
    createdAt: changeset.createdAt,
    updatedAt: changeset.updatedAt,
    closedAt: changeset.closedAt,
    closedBy: changeset.closedByAccountId,
    mergeMode: changeset.mergeMode === null ? null : changeset.mergeMode === 'fast_forward' ? 'fast-forward' : 'replay',
    mergedHash: changeset.mergedHash,
  };
}
