import { apply as applyLocally } from '@floorspec/ops';
import type { Diagnostic } from '@floorspec/engine';
import { decideChangeset, fetchChangeset, fetchChangesetModel, fetchChangesets, HttpFailure, type ChangesetLogEntry } from './api';
import { readModel, type EditorModel } from './model';
import type { EditorStore, Review } from './store';

/**
 * Live changesets, the client side (FLR-T-3.5). An agent working over MCP writes a named changeset
 * on a scratch head and never main (FLR-ADR-016); the editor hears it on the event stream, draws the
 * proposal over main, and a person accepts or rejects it.
 *
 * Rebase review: when main has moved since the changeset's base — the person edited, or accepted
 * something else — the server's accept would *replay* the changeset's batches onto main as it is
 * now. The editor runs that same replay first, locally, with @floorspec/ops (the applier the server
 * runs), and shows the rebased result. Accepting it then takes a second confirmation, and is sent
 * with `If-Match` on the main it was reviewed against, so a main that moved again is refused (412)
 * rather than merged unseen. A replay that fails — predicted here, or answered 409 by the server —
 * is shown with its diagnostics, its elements are outlined, and nothing merges.
 */

/** Re-read the pending changesets. */
export async function refreshProposals(store: EditorStore): Promise<void> {
  try {
    const rows = await fetchChangesets(store.projectId);
    store.set({ proposals: rows.filter((r) => r.status === 'pending') });
  } catch {
    // A token without read access, or a server between deploys: the proposals stay as they were.
  }
}

/** Open a changeset for review — or re-read the one under review after it grew. */
export async function openReview(store: EditorStore, id: string, options: { show?: boolean } = {}): Promise<void> {
  const current = store.get().review;
  const keep = current?.id === id ? current : null;
  store.set({
    review: keep === null
      ? { id, name: '…', createdBy: '', createdAt: new Date().toISOString(), base: '', log: [], proposed: null, rebased: null, failure: null, loading: true, busy: null, confirming: false }
      : { ...keep, loading: true, confirming: false },
    ...(options.show === false ? {} : { side: 'review' as const }),
  });
  try {
    const [detail, head] = await Promise.all([fetchChangeset(store.projectId, id), fetchChangesetModel(store.projectId, id)]);
    if (store.get().review?.id !== id) return;
    if (detail.status !== 'pending' || head === null) {
      closeReview(store);
      return;
    }
    const proposed = readModel(head.hash, head.text);
    store.set((s) => ({
      review: s.review === null || s.review.id !== id
        ? s.review
        : {
            ...s.review,
            name: detail.name,
            createdBy: detail.createdBy ?? 'an agent',
            createdAt: detail.createdAt,
            base: detail.base,
            log: detail.log,
            proposed,
            loading: false,
            failure: s.review.failure?.source === 'server' && s.review.failure.against === s.model?.hash ? s.review.failure : null,
          },
    }));
    rebase(store);
  } catch (error) {
    if (error instanceof HttpFailure && error.status === 404) {
      closeReview(store);
      return;
    }
    store.set((s) => ({ review: s.review === null ? null : { ...s.review, loading: false }, notice: { tone: 'danger', text: 'The proposal did not load. Try again from the proposals menu.' } }));
  }
}

export function closeReview(store: EditorStore): void {
  store.set({ review: null, side: 'inspector' });
}

/**
 * Replay the changeset's batches, as they were sent, onto main — what the server's accept would do.
 * Returns the result model, or the batch that failed and why.
 */
export function replay(main: EditorModel, log: readonly ChangesetLogEntry[]): { status: 'ok'; model: EditorModel; differs: number[] } | { status: 'failed'; index: number; diagnostics: Diagnostic[] } {
  let document: string | object = main.document;
  let hash = main.hash;
  const differs: number[] = [];
  const created: string[] = [];
  for (const [index, entry] of log.entries()) {
    const result = applyLocally(document, { batch: entry.ops, context: { retired: created } });
    if (result.status === 'rejected') return { status: 'failed', index, diagnostics: result.diagnostics };
    if (JSON.stringify(result.resolved) !== JSON.stringify(entry.resolved)) differs.push(index);
    created.push(...result.created);
    document = result.document;
    hash = result.hash;
  }
  return { status: 'ok', model: readModel(hash, document), differs };
}

/** When main is not the changeset's base, preview the rebased result (or the failure). */
export function rebase(store: EditorStore): void {
  const { review, model } = store.get();
  if (review === null || model === null || review.loading || review.proposed === null) return;
  if (review.base === model.hash) {
    if (review.rebased !== null || (review.failure !== null && review.failure.source === 'preview')) store.set({ review: { ...review, rebased: null, failure: null, confirming: false } });
    return;
  }
  if (review.rebased?.against === model.hash || review.failure?.against === model.hash) return;
  const outcome = replay(model, review.log);
  if (outcome.status === 'ok') {
    store.set({ review: { ...review, rebased: { against: model.hash, model: outcome.model, differs: outcome.differs }, failure: null, confirming: false } });
  } else {
    store.set({
      review: {
        ...review,
        rebased: null,
        confirming: false,
        failure: {
          against: model.hash,
          source: 'preview',
          failedIndex: outcome.index,
          diagnostics: outcome.diagnostics,
          detail: `Main has moved since “${review.name}” was proposed, and batch ${String(outcome.index + 1)} of ${String(review.log.length)} no longer applies to it. Accepting would merge nothing.`,
        },
      },
    });
  }
}

/** What the canvas draws for the review: the version proposed, against main. */
export function reviewTarget(review: Review | null, main: EditorModel | null): EditorModel | null {
  if (review === null || main === null || review.proposed === null) return null;
  if (review.base === main.hash) return review.proposed;
  return review.rebased?.against === main.hash ? review.rebased.model : null;
}

/** Whether accepting needs the second look: main moved since the changeset's base. */
export function needsRebase(review: Review, main: EditorModel | null): boolean {
  return main !== null && review.base !== '' && review.base !== main.hash;
}

/**
 * Accept. A fast-forward goes at once; a rebased changeset first asks for the second confirmation
 * (`confirmed`), and both are sent with `If-Match` on the main that was reviewed.
 */
export async function accept(store: EditorStore, confirmed = false): Promise<void> {
  const { review, model } = store.get();
  if (review === null || model === null || review.busy !== null || review.loading) return;
  if (review.failure !== null && review.failure.against === model.hash) return;
  const rebased = needsRebase(review, model);
  if (rebased) {
    if (review.rebased?.against !== model.hash) {
      rebase(store);
      return;
    }
    if (!confirmed) {
      store.set({ review: { ...review, confirming: true } });
      return;
    }
  }
  store.set({ review: { ...review, busy: 'accept', confirming: false } });
  const answer = await decideChangeset(store.projectId, review.id, 'accept', model.hash);
  const now = store.get().review;
  if (now?.id !== review.id) return;
  switch (answer.status) {
    case 'accepted':
      store.set({ review: null, side: 'inspector', notice: { tone: 'info', text: `“${review.name}” is in the plan${answer.mode === 'replay' ? ', replayed onto your latest changes' : ''}. Undo takes it back.` } });
      await store.follow(answer.hash, null);
      await refreshProposals(store);
      return;
    case 'replay-failed':
      store.set({
        review: { ...now, busy: null, failure: { against: model.hash, source: 'server', detail: answer.detail, diagnostics: answer.diagnostics, failedIndex: answer.failedIndex } },
      });
      return;
    case 'stale':
      store.set({ review: { ...now, busy: null }, notice: { tone: 'info', text: 'The plan changed while you were reviewing, so nothing was merged. The proposal has been rebased again — review it once more.' } });
      await store.reloadHead();
      return;
    default:
      store.set({ review: { ...now, busy: null }, notice: { tone: 'danger', text: answer.status === 'failed' ? answer.message : 'The changeset could not be accepted.' } });
  }
}

export async function reject(store: EditorStore): Promise<void> {
  const review = store.get().review;
  if (review === null || review.busy !== null) return;
  store.set({ review: { ...review, busy: 'reject', confirming: false } });
  const answer = await decideChangeset(store.projectId, review.id, 'reject');
  if (store.get().review?.id !== review.id) return;
  if (answer.status === 'rejected') {
    store.set({ review: null, side: 'inspector', notice: { tone: 'info', text: `“${review.name}” was discarded. Nothing in it reached the plan.` } });
    await refreshProposals(store);
  } else {
    store.set((s) => ({ review: s.review === null ? null : { ...s.review, busy: null }, notice: { tone: 'danger', text: answer.status === 'failed' ? answer.message : 'The changeset could not be rejected.' } }));
  }
}

/** The diagnostics the canvas outlines for the review: a replay failure's. */
export function reviewDiagnostics(review: Review | null, main: EditorModel | null): Diagnostic[] {
  if (review?.failure === null || review === null || main === null) return [];
  return review.failure.against === main.hash ? review.failure.diagnostics : [];
}
