import type { Diagnostic } from '@floorspec/engine';

/**
 * The seam between the store and the Floorspec Ops applier (Ops 0.1, chapter 1).
 *
 * The types here are the spec's request and result, exactly: the server hands the applier the
 * document at a head and an apply request, and stores what comes back. It never edits a document
 * itself (FLR-ADR-008). `@floorspec/ops` implements this; until it is merged the server is wired to
 * {@link unavailableApplier}, and the tests to a small fake.
 */

/** One operation: an object whose `op` member names it (Ops 1.1). Validated by the applier. */
export interface Op {
  readonly op: string;
  readonly [member: string]: unknown;
}

/** A batch is applied in order as one transaction (Ops 1.1). */
export type Batch = readonly Op[];

/** A lock in force (Ops chapter 6). */
export type Lock =
  | { readonly element: string }
  | { readonly length: string }
  | { readonly distance: readonly [string, string] };

/** The apply request (Ops 1.1). */
export interface ApplyRequest {
  readonly batch: Batch;
  readonly context?: {
    readonly locks?: readonly Lock[];
    /** IDs that once existed in this document's history and are never minted again (Ops 1.5). */
    readonly retired?: readonly string[];
  };
}

export interface Committed {
  readonly status: 'committed';
  /** B, as its canonical form (Core §9.2) — the canonical text, or the parsed document. */
  readonly document: string | object;
  /** B's content hash (Core §9.3). */
  readonly hash: string;
  /** The primitives actually applied, every reference resolved (Ops 1.4). */
  readonly resolved: Batch;
  /** IDs in B and not in A, sorted. */
  readonly created: readonly string[];
  /** IDs in A and not in B, sorted. */
  readonly removed: readonly string[];
  /** A batch that turns B back into A (Ops 1.6). */
  readonly inverse: Batch;
}

export interface Rejected {
  readonly status: 'rejected';
  readonly diagnostics: readonly Diagnostic[];
}

export type ApplyResult = Committed | Rejected;

export interface Applier {
  apply(document: unknown, request: ApplyRequest): ApplyResult;
}

/** Thrown when the server has no applier to call; answered 503, never a 500. */
export class ApplierUnavailable extends Error {
  constructor() {
    super('the Floorspec Ops applier is not installed in this build yet (FLR-T-2.3)');
    this.name = 'ApplierUnavailable';
  }
}

/** What the server runs until `@floorspec/ops` is merged: every apply is a clear 503. */
export const unavailableApplier: Applier = {
  apply() {
    throw new ApplierUnavailable();
  },
};

/** The parsed document of a committed result, whichever form the applier returned it in. */
export function documentOf(result: Committed): unknown {
  return typeof result.document === 'string' ? (JSON.parse(result.document) as unknown) : result.document;
}

/** Element shorthands that add under a named ID (Ops 2.1): what an undo or a replay may re-add. */
const ADDING_OPS = new Set(['addElement', 'addJunction', 'addWall', 'addSeparator']);

/** The IDs a batch's add operations name explicitly. */
export function idsNamedByAdds(batch: Batch): string[] {
  const ids: string[] = [];
  for (const op of batch) {
    if (ADDING_OPS.has(op.op) && typeof op['id'] === 'string') ids.push(op['id']);
  }
  return ids;
}
