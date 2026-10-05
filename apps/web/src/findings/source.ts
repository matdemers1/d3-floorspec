import { useEffect, useSyncExternalStore } from 'react';
import { api, messageOf } from '../lib/api';
import { onLive } from '../dashboard/live';
import type { FindingsReport, Severity } from './types';

/**
 * A project's findings, fetched once and shared by every surface showing them on a page — the
 * editor's findings panel and its plan overlay, the report, the dashboard card (FLR-T-6.9).
 *
 * Fetched again whenever the project's live stream says something moved (FLR-T-3.5): main moved
 * (the findings are of the committed head, after each batch: FLR-REQ-098), or the jurisdiction
 * profile changed (`profile`, FLR-T-6.8) — so a finding fixed in the editor disappears, and changing
 * the profile changes the set, without a reload.
 *
 * It also holds what the panel and the overlay share: the finding in focus and the severity shown.
 */

export interface FindingsState {
  status: 'loading' | 'ready' | 'failed';
  report: FindingsReport | null;
  error: string | null;
  /** The finding in focus (its key), drawn strongest and zoomed to. */
  focus: string | null;
  /** The severities shown, in the panel and on the plan. */
  show: Severity | 'all';
}

type Listener = () => void;

class Source {
  state: FindingsState = { status: 'loading', report: null, error: null, focus: null, show: 'all' };
  private readonly listeners = new Set<Listener>();
  private users = 0;
  private stopLive: (() => void) | null = null;
  private generation = 0;

  constructor(
    readonly projectId: string,
    /** Where the report comes from, and whether a project stream refreshes it — a share link's own route, and its own stream (FLR-T-9.6). */
    private readonly from: { url: string | null; live: boolean } = { url: `/api/projects/${projectId}/findings`, live: true },
  ) {}

  set(patch: Partial<FindingsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get = (): FindingsState => this.state;

  load(): void {
    const generation = ++this.generation;
    const url = this.from.url;
    // A share link that does not show findings: there is nothing to fetch, and nothing to draw.
    if (url === null) {
      this.set({ status: 'ready', report: null, error: null });
      return;
    }
    api
      .get<FindingsReport>(url)
      .then((report) => {
        if (generation !== this.generation) return;
        this.set({ status: 'ready', report, error: null });
      })
      .catch((caught: unknown) => {
        if (generation !== this.generation) return;
        this.set({ status: this.state.report === null ? 'failed' : 'ready', error: messageOf(caught) });
      });
  }

  join(): () => void {
    this.users += 1;
    if (this.users === 1) {
      this.load();
      // Every tick is something that moved after the stream opened.
      if (this.from.live) this.stopLive = onLive(this.projectId, () => { this.load(); });
    }
    return () => {
      this.users -= 1;
      if (this.users === 0) {
        this.stopLive?.();
        this.stopLive = null;
      }
    };
  }
}

const sources = new Map<string, Source>();

export function findingsSource(projectId: string): Source {
  let s = sources.get(projectId);
  if (s === undefined) {
    s = new Source(projectId);
    sources.set(projectId, s);
  }
  return s;
}

/**
 * The findings a share link shows (FLR-T-9.6), under a key of the viewer's own: fetched from the
 * link's route, never from a project's, and refreshed by the viewer when its stream says so.
 */
export function sharedFindingsSource(key: string, url: string | null): Source {
  let s = sources.get(key);
  if (s === undefined) {
    s = new Source(key, { url, live: false });
    sources.set(key, s);
  }
  return s;
}

export type FindingsSource = Source;

/** A project's findings, live; the source, to focus a finding or reload. */
export function useFindings(projectId: string): [FindingsState, Source] {
  const source = findingsSource(projectId);
  useEffect(() => source.join(), [source]);
  const state = useSyncExternalStore(source.subscribe, source.get);
  return [state, source];
}
