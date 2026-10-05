import { subscribe, type EventSourceFactory } from '../lib/events';
import type { EditorStore } from '../editor/store';

/**
 * The brief and the layouts on the event stream (FLR-T-3.5's, as the editor uses it): subscribe
 * first and load on `ready`, so nothing committed in between is missed; follow main when it moves
 * (an undo in another tab, Claude's accepted changeset); and tell the layouts screen when a
 * changeset opens or is decided. A stream that does not open falls back to a plain load.
 */

const FALLBACK_MS = 2_500;

export function connectProgramLive(
  store: EditorStore,
  onChangeset: () => void,
  options: { createEventSource?: EventSourceFactory; fallbackMs?: number } = {},
): () => void {
  let loaded = false;
  const load = () => {
    loaded = true;
    void store.load();
  };
  const fallback = setTimeout(() => {
    if (!loaded) load();
  }, options.fallbackMs ?? FALLBACK_MS);
  const unsubscribe = subscribe(
    store.projectId,
    (event) => {
      switch (event.type) {
        case 'ready':
          store.set({ live: 'live' });
          if (!loaded) {
            clearTimeout(fallback);
            load();
          } else if (!event.data.resumed) {
            void store.reloadHead();
            onChangeset();
          }
          return;
        case 'head':
          if (loaded) void store.follow(event.data.hash, event.data.seq);
          return;
        case 'changeset':
          onChangeset();
          return;
        case 'resync':
          if (loaded) {
            load();
            onChangeset();
          }
          return;
      }
    },
    {
      onState: (state) => { store.set({ live: state }); },
      ...(options.createEventSource === undefined ? {} : { createEventSource: options.createEventSource }),
    },
  );
  return () => {
    clearTimeout(fallback);
    unsubscribe();
  };
}
