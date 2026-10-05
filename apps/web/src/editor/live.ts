import { subscribe, type EventSourceFactory, type FloorspecEvent } from '../lib/events';
import type { EditorStore } from './store';
import { closeReview, openReview, refreshProposals, rebase } from './review';
import { refreshLog } from './history';

/**
 * The editor on the event stream (FLR-T-3.5). Subscribe first, load on `ready` — so nothing
 * committed between the load and the subscription is missed — then:
 *   - `head`: main moved (another tab, an undo, an accepted changeset): follow it, keeping the tool;
 *   - `changeset`: an agent opened or added to a proposal: show it; accepted or rejected: drop it;
 *   - `resync`: what was missed cannot be replayed: load everything again.
 * If the stream does not open (a proxy that buffers it), the editor loads anyway after a moment
 * and works as it did before, without live updates.
 */

const FALLBACK_MS = 2_500;

export function connectLive(store: EditorStore, options: { createEventSource?: EventSourceFactory; fallbackMs?: number } = {}): () => void {
  let loaded = false;
  const loadAll = async () => {
    loaded = true;
    await store.load();
    await refreshProposals(store);
    const review = store.get().review;
    const wanted = store.wanted;
    store.wanted = null;
    if (wanted !== null && store.get().proposals.some((p) => p.id === wanted)) await openReview(store, wanted);
    else if (review !== null) await openReview(store, review.id, { show: false });
    else {
      // A proposal already waiting when the editor opens is shown, as if it had just arrived —
      // unless the editor was opened on its findings (FLR-T-6.9): then it waits in the top bar.
      const first = store.get().proposals[0];
      if (first !== undefined) await openReview(store, first.id, { show: !store.get().findingsOpen });
    }
    if (store.get().left === 'history') await refreshLog(store);
  };
  const fallback = setTimeout(() => {
    if (!loaded) void loadAll();
  }, options.fallbackMs ?? FALLBACK_MS);

  store.onModel = () => {
    rebase(store);
    if (store.get().left === 'history') void refreshLog(store);
  };

  const handle = (event: FloorspecEvent) => {
    switch (event.type) {
      case 'ready':
        store.set({ live: 'live' });
        if (!loaded) {
          clearTimeout(fallback);
          void loadAll();
        } else if (!event.data.resumed) {
          // A fresh stream after a gap the server could not replay: re-read what is shown.
          void store.reloadHead().then(() => refreshProposals(store));
        }
        return;
      case 'head':
        if (!loaded) return;
        void store.follow(event.data.hash, event.data.seq);
        return;
      case 'changeset': {
        if (!loaded) return;
        const cs = event.data;
        void refreshProposals(store);
        const s = store.get();
        if (cs.change === 'opened' || cs.change === 'appended') {
          if (s.review === null || s.review.id === cs.id) {
            // Shown at once — unless the person is mid-gesture: then it waits in the top bar.
            const busy = s.draft !== null && (s.draft.tool !== 'select' || s.draft.drag !== null);
            void openReview(store, cs.id, { show: !busy && s.compare === null });
            if (busy || s.review === null) store.set({ notice: { tone: 'info', text: `${cs.createdBy} is proposing “${cs.name}”.` } });
          }
          return;
        }
        if (s.review?.id === cs.id && s.review.busy === null) {
          if (cs.change === 'replay-failed') {
            // Somebody else's accept failed; this editor's own preview says why.
            rebase(store);
            return;
          }
          closeReview(store);
          store.set({ notice: { tone: 'info', text: cs.change === 'accepted' ? `“${cs.name}” was accepted.` : `“${cs.name}” was rejected.` } });
        }
        return;
      }
      case 'resync':
        if (!loaded) return;
        void loadAll();
        return;
    }
  };

  const unsubscribe = subscribe(store.projectId, handle, {
    onState: (state) => { store.set({ live: state }); },
    ...(options.createEventSource === undefined ? {} : { createEventSource: options.createEventSource }),
  });
  return () => {
    clearTimeout(fallback);
    unsubscribe();
    store.onModel = null;
  };
}
