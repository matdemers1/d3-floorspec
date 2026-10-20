import { useSyncExternalStore } from 'react';
import type { StreetSide, TreeDensity } from '@floorspec/engine';
import type { EditorStore } from '../store';
import type { Point } from '../model';

/**
 * Context in the editor (FLR-T-15.3, FS_context): beside the editor's store, as the site's state is.
 * What it holds is the viewer's, never the model: what the next generation asks for — the street side,
 * the carriageway, the sidewalk and strip, the neighbours and how many trees — the seed it is drawn
 * with, the record picked in the Context panel, and a record being dragged on the plan. What a person
 * keeps — the street, the neighbours, the trees — is FS_context in the document, written as Ops (ops.ts).
 * Whether context shows, ghosts or hides is the plan's Context layer (modes.ts), which the 3D view reads too.
 */

export type ContextMember = 'streets' | 'neighbours' | 'trees';

export interface ContextDrag {
  member: ContextMember;
  id: string;
  from: Point;
  to: Point;
}

export interface ContextState {
  /** The street side to generate from: null for FS_site's street edges (or the lot's south). */
  side: StreetSide | null;
  /** The carriageway, curb to curb, and each sidewalk and strip, in feet. */
  width: number;
  sidewalk: number;
  strip: number;
  /** Neighbours on both sides, at the lot's own setbacks. */
  neighbours: boolean;
  trees: TreeDensity;
  /** What a hand-placed tree is. */
  treeForm: 'deciduous' | 'evergreen';
  /** The generator's seed: Regenerate draws the next. */
  seed: number;
  /** The record picked in the panel or on the plan. */
  selected: { member: ContextMember; id: string } | null;
  drag: ContextDrag | null;
}

const DEFAULTS: ContextState = { side: null, width: 30, sidewalk: 5, strip: 4, neighbours: true, trees: 'some', treeForm: 'deciduous', seed: 1, selected: null, drag: null };

const key = (projectId: string) => `fs-context:${projectId}`;
type Kept = Pick<ContextState, 'side' | 'width' | 'sidewalk' | 'strip' | 'neighbours' | 'trees' | 'treeForm' | 'seed'>;

export class ContextStore {
  private state: ContextState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: EditorStore) {
    let saved: Partial<Kept> = {};
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key(editor.projectId));
      if (raw !== null) saved = JSON.parse(raw) as Partial<Kept>;
    } catch {
      saved = {};
    }
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000 ? v : d);
    this.state = {
      ...DEFAULTS,
      side: saved.side === 'north' || saved.side === 'east' || saved.side === 'south' || saved.side === 'west' ? saved.side : null,
      width: num(saved.width, DEFAULTS.width),
      sidewalk: num(saved.sidewalk, DEFAULTS.sidewalk),
      strip: num(saved.strip, DEFAULTS.strip),
      neighbours: typeof saved.neighbours === 'boolean' ? saved.neighbours : DEFAULTS.neighbours,
      trees: saved.trees === 'none' || saved.trees === 'few' || saved.trees === 'some' || saved.trees === 'many' ? saved.trees : DEFAULTS.trees,
      treeForm: saved.treeForm === 'evergreen' ? 'evergreen' : 'deciduous',
      seed: Number.isSafeInteger(saved.seed) && (saved.seed ?? 0) > 0 ? (saved.seed as number) : DEFAULTS.seed,
    };
  }

  get = (): ContextState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  set(patch: Partial<ContextState>): void {
    this.state = { ...this.state, ...patch };
    try {
      const { side, width, sidewalk, strip, neighbours, trees, treeForm, seed } = this.state;
      localStorage.setItem(key(this.editor.projectId), JSON.stringify({ side, width, sidewalk, strip, neighbours, trees, treeForm, seed }));
    } catch {
      // private browsing: the settings last the session
    }
    for (const fn of this.listeners) fn();
  }
}

const stores = new WeakMap<EditorStore, ContextStore>();

export function contextOf(store: EditorStore): ContextStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new ContextStore(store);
    stores.set(store, s);
  }
  return s;
}

export function useContextState<T>(store: EditorStore, selector: (s: ContextState) => T): T {
  const s = contextOf(store);
  return useSyncExternalStore(s.subscribe, () => selector(s.get()), () => selector(s.get()));
}
