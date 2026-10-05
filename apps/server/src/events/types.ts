import type { AuthorKind, ChangesetStatus, OpKind } from '../generated/prisma/enums.js';

/**
 * What the live stream carries (FLR-T-3.5): **that** something moved, never the model itself. A
 * subscriber that wants the new document fetches it by hash, which is immutable and cacheable; the
 * event is small enough for a Postgres NOTIFY payload and safe to replay from a ring.
 */

/** Main moved: an apply, an undo or redo, or a merge from an accepted changeset. */
export interface HeadEventData {
  readonly head: 'main';
  readonly hash: string;
  /** The op-log seq of the newest op on main. */
  readonly seq: number;
  readonly kind: OpKind;
  readonly authorKind: AuthorKind;
  /** The agent's name, `token:<id>` for a person's token, or the account ID. */
  readonly author: string;
  /** The changeset whose accept moved main, when one did. */
  readonly changeset: string | null;
}

/** What happened to a changeset. `replay-failed` leaves it pending and changes nothing. */
export type ChangesetChange = 'opened' | 'appended' | 'accepted' | 'rejected' | 'replay-failed';

export interface ChangesetEventData {
  readonly id: string;
  readonly name: string;
  readonly status: ChangesetStatus;
  readonly change: ChangesetChange;
  /** The changeset's scratch head, `cs/<id>`. */
  readonly head: string;
  /**
   * Pending: the scratch head's version (the ghosted overlay). Accepted: main's version after the
   * merge. Rejected: null.
   */
  readonly hash: string | null;
  /** The base the changeset was opened at. */
  readonly base: string;
  /** How many batches the changeset holds. */
  readonly ops: number;
  readonly createdBy: string;
  readonly mergeMode: 'fast-forward' | 'replay' | null;
}

/**
 * The jurisdiction profile the project's findings are evaluated under changed (FLR-T-6.8): another
 * was chosen, or the one in use was edited or deleted. The model did not move, but its findings may
 * have: a subscriber showing findings fetches them again.
 */
export interface ProfileEventData {
  /** The profile now in use; null for the instance default. */
  readonly id: string | null;
  readonly name: string;
  readonly change: 'chosen' | 'edited' | 'deleted';
}

/**
 * A comment changed (FLR-T-9.6): who may see it is the stream's business — the owner's comments
 * stream passes every one, a share link's stream only its own link's. Never the text: a subscriber
 * fetches the thread.
 */
export interface CommentEventData {
  readonly id: string;
  /** The thread's root. */
  readonly thread: string;
  /** The share link the thread was made through. */
  readonly link: string | null;
  readonly change: 'created' | 'replied' | 'edited' | 'deleted' | 'resolved' | 'reopened';
}

/** A share link was made or revoked (FLR-T-9.6): a revoked link's open streams end. */
export interface ShareEventData {
  readonly id: string;
  readonly change: 'created' | 'revoked';
}

export type ProjectEvent =
  | { readonly projectId: string; readonly type: 'head'; readonly data: HeadEventData }
  | { readonly projectId: string; readonly type: 'changeset'; readonly data: ChangesetEventData }
  | { readonly projectId: string; readonly type: 'profile'; readonly data: ProfileEventData }
  | { readonly projectId: string; readonly type: 'comment'; readonly data: CommentEventData }
  | { readonly projectId: string; readonly type: 'share'; readonly data: ShareEventData };

export type ProjectEventType = ProjectEvent['type'];

/** The NOTIFY channel every api process LISTENs on. */
export const CHANNEL = 'floorspec_events';
