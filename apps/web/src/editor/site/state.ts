import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';

/**
 * The site in the editor (FLR-T-15.1, FS_site): beside the editor's store, as the annotation and
 * precision state are. What it holds is the viewer's, never the model: the heights the spot, contour
 * and pad tools will write next, the contour interval the plan draws, and how the 3D view shows the
 * terrain (contours on the ground, cut and fill tinted, the vertical exaggeration — a view setting
 * only: no elevation, volume or model ever changes with it). What a person keeps — the lot, the survey,
 * the setbacks and the pads — is FS_site and Core's site in the document, written as Ops (ops.ts).
 */

export type Exaggeration = 1 | 1.6 | 2;

export interface Terrain3D {
  /** The Terrain panel in the 3D view. */
  open: boolean;
  /** Contour lines drawn on the ground. */
  contours: boolean;
  /** The ground tinted where it is cut (amber) and filled (blue). */
  tint: boolean;
  /** The ground in its lawn, or plain. */
  lawn: boolean;
  /** The house drawn faint, to see the ground under it. */
  ghost: boolean;
  /** Heights stretched in the view, never in the model. */
  exaggeration: Exaggeration;
}

export interface SiteState {
  /** The heights the spot, contour and pad tools write next, as typed: survey feet, "811.25". Empty: the ground's own. */
  spot: string;
  contour: string;
  pad: string;
  /** The plan's contour interval, in feet of the survey's datum; every fifth is a major one. */
  interval: number;
  terrain: Terrain3D;
}

const DEFAULTS: SiteState = {
  spot: '',
  contour: '',
  pad: '',
  interval: 1,
  terrain: { open: false, contours: true, tint: true, lawn: true, ghost: false, exaggeration: 1 },
};

const key = (projectId: string) => `fs-site:${projectId}`;

export class SiteStore {
  private state: SiteState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: EditorStore) {
    let saved: Partial<Pick<SiteState, 'interval'>> & { terrain?: Partial<Terrain3D> } = {};
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key(editor.projectId));
      if (raw !== null) saved = JSON.parse(raw) as typeof saved;
    } catch {
      saved = {};
    }
    const interval = typeof saved.interval === 'number' && [0.5, 1, 2, 5].includes(saved.interval) ? saved.interval : DEFAULTS.interval;
    this.state = { ...DEFAULTS, interval, terrain: { ...DEFAULTS.terrain, ...(saved.terrain ?? {}), open: false } };
  }

  get = (): SiteState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  set(patch: Partial<Omit<SiteState, 'terrain'>> & { terrain?: Partial<Terrain3D> }): void {
    this.state = { ...this.state, ...patch, terrain: { ...this.state.terrain, ...(patch.terrain ?? {}) } };
    try {
      const terrain: Partial<Terrain3D> = { ...this.state.terrain };
      delete terrain.open;
      localStorage.setItem(key(this.editor.projectId), JSON.stringify({ interval: this.state.interval, terrain }));
    } catch {
      // private browsing: the setting lasts the session
    }
    for (const fn of this.listeners) fn();
  }
}

const stores = new WeakMap<EditorStore, SiteStore>();

export function siteOf(store: EditorStore): SiteStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new SiteStore(store);
    stores.set(store, s);
  }
  return s;
}

export function useSite<T>(store: EditorStore, selector: (s: SiteState) => T): T {
  const s = siteOf(store);
  return useSyncExternalStore(s.subscribe, () => selector(s.get()), () => selector(s.get()));
}
