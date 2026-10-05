import { useEffect, useState } from 'react';
import { subscribe } from '../lib/events';

/**
 * The dashboard's live updates (FLR-T-3.5): one event stream per project, shared by the cards that
 * show what moves — the changesets card and the versions card. A card reads a tick that changes
 * whenever main moves or a changeset is opened, appended to, accepted or rejected, and loads again.
 */

interface Shared {
  tick: number;
  listeners: Set<(tick: number) => void>;
  stop: () => void;
}

const streams = new Map<string, Shared>();

/** Listen to a project's shared stream: `listener` gets the new tick whenever something moved. */
export function onLive(projectId: string, listener: (tick: number) => void): () => void {
  let shared = streams.get(projectId);
  if (shared === undefined) {
    const created: Shared = { tick: 0, listeners: new Set(), stop: () => undefined };
    created.stop = subscribe(projectId, (event) => {
      // `ready` after a gap the server could not replay, `resync`, and every move: load again.
      if (event.type === 'ready' && event.data.resumed) return;
      // A replay that failed changed nothing — and the card showing why must keep showing it.
      if (event.type === 'changeset' && event.data.change === 'replay-failed') return;
      if (event.type === 'ready' && created.tick === 0) {
        created.tick = 1;
        return;
      }
      created.tick += 1;
      for (const l of created.listeners) l(created.tick);
    });
    streams.set(projectId, created);
    shared = created;
  }
  const s = shared;
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
    if (s.listeners.size === 0) {
      s.stop();
      streams.delete(projectId);
    }
  };
}

/** A number that changes whenever something the dashboard shows moved on the server. */
export function useLiveTick(projectId: string): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onLive(projectId, setTick), [projectId]);
  return tick;
}
