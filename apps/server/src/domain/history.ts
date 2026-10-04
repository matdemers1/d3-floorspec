import type { Request } from 'express';
import type { Tx } from '../db.js';
import { Prisma } from '../db.js';
import type { AuthorKind, OpKind } from '../generated/prisma/enums.js';
import type { OpLog } from '../generated/prisma/client.js';
import { HttpError } from '../http/errors.js';
import { ProblemError } from '../http/problem.js';
import { isAgent } from '../http/context.js';
import {
  documentOf,
  type Applier,
  type Batch,
  type Committed,
  type Lock,
  type Rejected,
} from '../ops/applier.js';
import { MAIN, storeVersion } from './projects.js';

/**
 * The store behind every edit (FLR-T-2.4): a head names a version, an edit is a batch of Floorspec
 * Ops handed to the applier against that version, and a committed result becomes a new version, an
 * appended op-log row and a moved head — in one transaction, or not at all.
 *
 * Writes to one project are serialised by a row lock on the project, which also makes `seq` safe to
 * compute as one more than the last. Optimistic concurrency is the caller's choice: `If-Match` with
 * the head's hash, and a head that has moved since is a 412.
 */

/** Who an op is recorded as. */
export interface Author {
  readonly kind: AuthorKind;
  readonly accountId: string | null;
  readonly agent: string | null;
  readonly tokenId: string | null;
}

/** The author a request writes as: a session's person, a person's write token, or an agent. */
export function authorOf(req: Request): Author {
  if (req.auth !== undefined) return { kind: 'account', accountId: req.auth.accountId, agent: null, tokenId: null };
  const token = req.token;
  if (token === undefined) throw new HttpError(401, 'sign in first');
  if (isAgent(token)) return { kind: 'agent', accountId: token.accountId, agent: token.name, tokenId: token.tokenId };
  return { kind: 'token', accountId: token.accountId, agent: null, tokenId: token.tokenId };
}

/** The scratch head of a changeset. */
export function changesetHead(changesetId: string): string {
  return `cs/${changesetId}`;
}

/** Serialise every write to one project for the rest of the transaction. */
export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`select 1 from projects where id = ${projectId}::uuid for update`;
}

export interface HeadState {
  readonly name: string;
  readonly hash: string;
  readonly document: unknown;
}

export async function readHead(tx: Tx, projectId: string, name: string): Promise<HeadState> {
  const head = await tx.head.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { version: { select: { document: true } } },
  });
  if (head === null) throw new HttpError(404, name === MAIN ? 'this project has no model yet' : 'changeset not found');
  return { name, hash: head.versionHash, document: head.version.document };
}

/**
 * `If-Match` against a head: absent is "whatever the head is now"; present must name the head's
 * hash, quoted as an ETag or bare, or the answer is 412 with the hash the head is actually at.
 */
export function checkIfMatch(ifMatch: string | undefined, head: HeadState): void {
  if (ifMatch === undefined || ifMatch.trim() === '*') return;
  const wanted = ifMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
  if (!wanted.includes(head.hash)) {
    throw new ProblemError({
      status: 412,
      type: 'stale-head',
      title: 'the head has moved since you read it',
      detail: `${head.name} is at ${head.hash}; read it again and resend the batch against that version.`,
      head: head.name,
      hash: head.hash,
    });
  }
}

/**
 * `context.retired` (Ops 1.5): every ID the project has ever minted or held, on any head, so none is
 * minted again. `exceptChangeset` and `exceptIds` let an edit bring back an element under its own
 * ID — an undo restoring what an op removed, a changeset replaying the IDs it minted itself — which
 * is the same element returning, not an ID being reused.
 */
export async function retiredFor(
  tx: Tx,
  projectId: string,
  except: { readonly changesetId?: string; readonly ids?: readonly string[] } = {},
): Promise<string[]> {
  const rows = await tx.retiredId.findMany({ where: { projectId }, select: { elementId: true, changesetId: true } });
  const skip = new Set(except.ids ?? []);
  return rows
    .filter((row) => !skip.has(row.elementId) && (except.changesetId === undefined || row.changesetId !== except.changesetId))
    .map((row) => row.elementId)
    .sort();
}

/** Record IDs as retired for good; the first head to hold an ID keeps the claim. */
export async function retire(tx: Tx, projectId: string, ids: readonly string[], changesetId: string | null): Promise<void> {
  if (ids.length === 0) return;
  await tx.retiredId.createMany({
    data: ids.map((elementId) => ({ projectId, elementId, changesetId })),
    skipDuplicates: true,
  });
}

const COLLECTION_NAMES = new Set([
  'buildings', 'levels', 'junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'types', 'materials', 'assets', 'roofs', 'stairs',
]);

/** Element IDs only — the members of the document's collections. */
export function elementIdsIn(document: unknown): string[] {
  if (typeof document !== 'object' || document === null) return [];
  const ids: string[] = [];
  for (const [name, value] of Object.entries(document as Record<string, unknown>)) {
    if (!COLLECTION_NAMES.has(name) || typeof value !== 'object' || value === null) continue;
    ids.push(...Object.keys(value));
  }
  return ids;
}

export interface ApplyInput {
  readonly projectId: string;
  readonly head: string;
  readonly batch: Batch;
  readonly locks?: readonly Lock[];
  readonly author: Author;
  readonly kind: OpKind;
  readonly ifMatch?: string | undefined;
  readonly changesetId?: string | null;
  readonly undoOfId?: string | null;
  readonly retiredExcept?: { readonly changesetId?: string; readonly ids?: readonly string[] };
}

export type ApplyOutcome =
  | { readonly status: 'committed'; readonly op: OpLog; readonly result: Committed; readonly before: string }
  | { readonly status: 'rejected'; readonly result: Rejected; readonly head: HeadState };

/** Run the applier against a document and a context. Pure apart from the applier itself. */
export function runApplier(applier: Applier, document: unknown, batch: Batch, retired: readonly string[], locks?: readonly Lock[]) {
  return applier.apply(document, {
    batch,
    context: { retired, ...(locks === undefined || locks.length === 0 ? {} : { locks }) },
  });
}

/**
 * Apply a batch to a head and, if it commits, record it. A rejection changes nothing: the caller
 * answers 422 with the applier's diagnostics.
 */
export async function applyToHead(tx: Tx, applier: Applier, input: ApplyInput): Promise<ApplyOutcome> {
  await lockProject(tx, input.projectId);
  const head = await readHead(tx, input.projectId, input.head);
  checkIfMatch(input.ifMatch, head);
  const retired = await retiredFor(tx, input.projectId, input.retiredExcept);
  const result = runApplier(applier, head.document, input.batch, retired, input.locks);
  if (result.status === 'rejected') return { status: 'rejected', result, head };
  const op = await commitResult(tx, {
    projectId: input.projectId,
    head: input.head,
    before: head.hash,
    batch: input.batch,
    result,
    author: input.author,
    kind: input.kind,
    changesetId: input.changesetId ?? null,
    undoOfId: input.undoOfId ?? null,
  });
  return { status: 'committed', op, result, before: head.hash };
}

export interface CommitInput {
  readonly projectId: string;
  readonly head: string;
  readonly before: string;
  readonly batch: Batch;
  readonly result: Pick<Committed, 'document' | 'hash' | 'resolved' | 'inverse' | 'created' | 'removed'>;
  readonly author: Author;
  readonly kind: OpKind;
  readonly changesetId: string | null;
  readonly undoOfId: string | null;
  /** The changeset an ID minted here is first recorded against, for a later replay. */
  readonly retireAs?: string | null;
}

/**
 * Record a committed result: store B (deduplicated by hash), append the op, retire what it created,
 * move the head. The caller holds the project lock.
 */
export async function commitResult(tx: Tx, input: CommitInput): Promise<OpLog> {
  const document = documentOf(input.result as Committed) as Prisma.InputJsonValue;
  const hash = await storeVersion(tx, document as never);
  if (hash !== input.result.hash) {
    // The applier's hash and the engine's disagree: one of them is wrong, and storing either would
    // key a version by a hash that is not its content's.
    throw new Error(`the applier reported ${input.result.hash} but the document hashes to ${hash}`);
  }
  const op = await appendOp(tx, {
    projectId: input.projectId,
    head: input.head,
    kind: input.kind,
    author: input.author,
    batch: input.batch,
    resolved: input.result.resolved,
    inverse: input.result.inverse,
    created: input.result.created,
    removed: input.result.removed,
    before: input.before,
    after: hash,
    changesetId: input.changesetId,
    undoOfId: input.undoOfId,
  });
  await retire(tx, input.projectId, [...input.result.created, ...input.result.removed], input.retireAs ?? input.changesetId);
  await moveHead(tx, input.projectId, input.head, hash);
  return op;
}

export interface AppendInput {
  readonly projectId: string;
  readonly head: string;
  readonly kind: OpKind;
  readonly author: Author;
  readonly batch: Batch;
  readonly resolved: Batch | null;
  readonly inverse: Batch | null;
  readonly created: readonly string[];
  readonly removed: readonly string[];
  readonly before: string | null;
  readonly after: string;
  readonly changesetId: string | null;
  readonly undoOfId: string | null;
}

export async function appendOp(tx: Tx, input: AppendInput): Promise<OpLog> {
  const last = await tx.opLog.findFirst({ where: { projectId: input.projectId }, orderBy: { seq: 'desc' }, select: { seq: true } });
  return tx.opLog.create({
    data: {
      projectId: input.projectId,
      seq: (last?.seq ?? 0) + 1,
      kind: input.kind,
      head: input.head,
      authorKind: input.author.kind,
      authorAccountId: input.author.accountId,
      authorAgent: input.author.agent,
      authorTokenId: input.author.tokenId,
      ops: input.batch as unknown as Prisma.InputJsonArray,
      resolved: input.resolved === null ? Prisma.DbNull : (input.resolved as unknown as Prisma.InputJsonArray),
      inverse: input.inverse === null ? Prisma.DbNull : (input.inverse as unknown as Prisma.InputJsonArray),
      created: [...input.created],
      removed: [...input.removed],
      beforeHash: input.before,
      afterHash: input.after,
      changesetId: input.changesetId,
      undoOfId: input.undoOfId,
    },
  });
}

export async function moveHead(tx: Tx, projectId: string, name: string, hash: string): Promise<void> {
  await tx.head.upsert({
    where: { projectId_name: { projectId, name } },
    create: { projectId, name, versionHash: hash },
    update: { versionHash: hash },
  });
}

// ─── Undo and redo ─────────────────────────────────────────────────────────

type UndoCandidate = Pick<OpLog, 'id' | 'seq' | 'kind' | 'undoOfId' | 'inverse'>;

/**
 * What `undo` and `redo` invert (FLR-T-2.4). History is never rewritten: undoing appends the stored
 * inverse of an op as a new op, and undoing an undo — a redo — appends the inverse of that.
 *
 * Walking main's log newest first, an `undo` or `redo` cancels the op it inverted, and the two are
 * passed over together. Then:
 *   - **undo** targets the first op left that is neither an undo nor a redo — the newest edit
 *     whose effect is still in the document;
 *   - **redo** targets the first `undo` left, provided no ordinary edit came after it: a new edit
 *     ends the redo trail, as it does everywhere else.
 */
export function undoTarget(opsNewestFirst: readonly UndoCandidate[], mode: 'undo' | 'redo'): UndoCandidate | null {
  const cancelled = new Set<string>();
  for (const op of opsNewestFirst) {
    if (cancelled.has(op.id)) continue;
    if (op.kind === 'create') return null;
    if (mode === 'undo') {
      if (op.kind === 'undo' || op.kind === 'redo') {
        if (op.undoOfId !== null) cancelled.add(op.undoOfId);
        continue;
      }
      return op.inverse === null ? null : op;
    }
    if (op.kind === 'redo') {
      if (op.undoOfId !== null) cancelled.add(op.undoOfId);
      continue;
    }
    if (op.kind === 'undo') return op;
    return null;
  }
  return null;
}

export async function undoCandidates(tx: Tx, projectId: string): Promise<UndoCandidate[]> {
  return tx.opLog.findMany({
    where: { projectId, head: MAIN },
    orderBy: { seq: 'desc' },
    select: { id: true, seq: true, kind: true, undoOfId: true, inverse: true },
  });
}
