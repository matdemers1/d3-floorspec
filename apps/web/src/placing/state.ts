import { useSyncExternalStore } from 'react';
import type { EditorStore, ToolId } from '../editor/store';
import type { Point } from '../editor/model';
import { labelOf } from '../editor/model';
import { gridStep } from '../editor/units';
import { toWorld } from '../editor/viewport';
import { drawersOf } from '../editor/drawers';
import { modesOf } from '../editor/modes';
import { entryByKey, type Entry, type GroupId } from './catalog';
import { ghostOf, type Ghost } from './ghost';
import { placeGhost } from './place';

/**
 * Adding things (FLR-T-18.7), beside the editor's store as the furniture library's and the
 * arrangement's state are: the library drawer's search, chip, recents and favourites; the entry being
 * placed and how it is turned; its ghost; a card being dragged onto the plan; and the quick-add bar.
 * What is placed is in the model — each placement one batch, so one undo — and the recents and
 * favourites are this browser's own (a person's convenience, never the model's).
 */

export interface QuickState {
  query: string;
  /** The highlighted result. */
  index: number;
  /** Where it places: the pointer when / was pressed, in plan. */
  at: Point;
}

export interface PlacingState {
  /** The left drawer shows the library rather than the tree. */
  panel: boolean;
  query: string;
  group: GroupId | 'all';
  /** Bumped to ask the drawer's search field for focus. */
  focusSearch: number;
  /** The entry being placed by clicks (the `place` tool), or by a drag. */
  active: string | null;
  /** Turned by hand: degrees counter-clockwise, and whether it was. */
  rotation: number;
  turned: boolean;
  ghost: Ghost | null;
  /** The last pointer tolerance and ⌥, so a turn or a nudge recomputes the ghost in place. */
  tol: number;
  free: boolean;
  /** A card dragged from the drawer: where the pointer is on the screen, and whether over the plan. */
  dragging: { key: string; x: number; y: number; over: boolean } | null;
  quick: QuickState | null;
  /** The quick-add bar's highlighted entry, ghosted at its point. */
  quickKey: string | null;
  recent: readonly string[];
  favourites: readonly string[];
  /** Placements sent and not yet answered. */
  busy: number;
}

const RECENT_KEY = 'floorspec.library.recent';
const FAVOURITES_KEY = 'floorspec.library.favourites';
const RECENT_MAX = 8;

function readList(key: string): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 64) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage refused (a private window): the list lasts for this session.
  }
}

export class PlacingStore {
  private state: PlacingState = {
    panel: false,
    query: '',
    group: 'all',
    focusSearch: 0,
    active: null,
    rotation: 0,
    turned: false,
    ghost: null,
    tol: 0,
    free: false,
    dragging: null,
    quick: null,
    quickKey: null,
    recent: readList(RECENT_KEY),
    favourites: readList(FAVOURITES_KEY),
    busy: 0,
  };
  private readonly listeners = new Set<() => void>();

  get = (): PlacingState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<PlacingState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

const stores = new WeakMap<EditorStore, PlacingStore>();

export function placingOf(store: EditorStore): PlacingStore {
  let p = stores.get(store);
  if (p === undefined) {
    const made = new PlacingStore();
    p = made;
    stores.set(store, made);
    // Leaving the place tool (another tool, Esc) ends click-to-place; another level drops the ghost.
    let was = { tool: store.get().tool, level: store.get().level };
    store.subscribe(() => {
      const s = store.get();
      if (s.tool !== was.tool && s.tool !== 'place' && made.get().active !== null && made.get().dragging === null) made.set({ active: null, ghost: null, turned: false, rotation: 0 });
      if (s.level !== was.level && made.get().ghost !== null) made.set({ ghost: null });
      was = { tool: s.tool, level: s.level };
    });
  }
  return p;
}

export function usePlacing<T>(store: EditorStore, selector: (s: PlacingState) => T): T {
  const p = placingOf(store);
  const snapshot = (): T => selector(p.get());
  return useSyncExternalStore(p.subscribe, snapshot, snapshot);
}

// ─── The library drawer ───────────────────────────────────────────────────────────────────────

/** The chip a trade mode opens the library on (FLR-T-18.3): its own things first. */
function groupForMode(store: EditorStore): GroupId | 'all' {
  const trade = modesOf(store).tradeOf();
  switch (trade) {
    case 'landscape':
      return 'outdoor';
    case 'electrical':
      return 'electrical';
    case 'plumbing':
      return 'plumbing';
    case 'mechanical':
      return 'mechanical';
    case 'lowvoltage':
      return 'lowvoltage';
    case 'construction':
      return 'doors';
    default:
      return 'all';
  }
}

/** Open the library in the left drawer — summoned if it is away — with its search focused (I). */
export function openLibrary(store: EditorStore, options: { group?: GroupId | 'all'; focus?: boolean } = {}): void {
  const p = placingOf(store);
  const was = p.get().panel;
  p.set({ panel: true, ...(options.group !== undefined ? { group: options.group } : was ? {} : { group: groupForMode(store) }), focusSearch: options.focus === false ? p.get().focusSearch : p.get().focusSearch + 1 });
  drawersOf(store).reveal('left');
}

export function closeLibrary(store: EditorStore): void {
  placingOf(store).set({ panel: false });
}

export function toggleFavourite(store: EditorStore, key: string): void {
  const p = placingOf(store);
  const list = p.get().favourites;
  const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  p.set({ favourites: next });
  writeList(FAVOURITES_KEY, next);
}

function pushRecent(store: EditorStore, key: string): void {
  const p = placingOf(store);
  const next = [key, ...p.get().recent.filter((k) => k !== key)].slice(0, RECENT_MAX);
  p.set({ recent: next });
  writeList(RECENT_KEY, next);
}

// ─── The ghost ─────────────────────────────────────────────────────────────────────────────────

export const entryOf = (store: EditorStore, key: string | null): Entry | undefined => (key === null ? undefined : entryByKey(store.get().model?.document, key));

/** The ghost of an entry at a plan point on the current level, with the editor's grid and the placing state's turn. */
export function computeGhost(store: EditorStore, entry: Entry, at: Point, tol: number, free: boolean): Ghost | null {
  const level = store.levelView;
  const model = store.get().model;
  if (level === undefined || model === null) return null;
  const p = placingOf(store).get();
  return ghostOf(level, entry, at, {
    tol,
    grid: gridStep(store.units),
    rotation: p.rotation,
    turned: p.turned,
    free,
    roomName: (id) => labelOf(model, id),
    wallName: (id) => labelOf(model, id),
  });
}

/** The pointer's tolerance when none was measured: 8 CSS pixels at the current zoom. */
function defaultTol(store: EditorStore): number {
  const view = store.get().view;
  return view === null ? 0 : 8 / view.s;
}

/** Move the ghost of the entry being placed (or dragged) to a plan point. */
export function moveGhost(store: EditorStore, at: Point, tol: number, free: boolean): void {
  const p = placingOf(store);
  const key = p.get().dragging?.key ?? p.get().active;
  const entry = entryOf(store, key);
  if (entry === undefined) return;
  p.set({ ghost: computeGhost(store, entry, at, tol, free), tol, free });
}

/** The point the keyboard places at: the pointer's last place on the plan, else the middle of the view. */
export function keyboardPoint(store: EditorStore): Point | null {
  const s = store.get();
  if (s.cursor !== null) return s.cursor;
  if (s.view === null) return null;
  return [s.view.cx, s.view.cy];
}

/**
 * Click-to-place an entry (a click on a card, Enter on one, ⇧Enter in the quick-add bar): the place
 * tool, the ghost following the pointer — or at the keyboard's point, for the arrows to move — each
 * click placing one, until Esc or another tool.
 */
export function startPlacing(store: EditorStore, key: string): void {
  const s = store.get();
  if (s.readOnly !== null || s.level === null) return;
  const p = placingOf(store);
  if (p.get().active !== key) p.set({ rotation: 0, turned: false });
  store.setTool('place');
  p.set({ active: key, ghost: null });
  const at = keyboardPoint(store);
  if (at !== null) moveGhost(store, at, defaultTol(store), false);
}

/** Stop placing: back to the select tool. */
export function stopPlacing(store: EditorStore, tool: ToolId = 'select'): void {
  placingOf(store).set({ active: null, ghost: null });
  if (store.get().tool === 'place') store.setTool(tool);
}

/** Turn the ghost by `degrees` (counter-clockwise), recomputed where it is. */
export function turnGhost(store: EditorStore, degrees: number): boolean {
  const p = placingOf(store);
  const st = p.get();
  const key = st.dragging?.key ?? st.active;
  if (key === null) return false;
  // A backed item turns from the way it faces the room, not from east.
  const from = st.turned ? st.rotation : st.ghost === null ? 0 : Math.round((Math.atan2(st.ghost.facing[1], st.ghost.facing[0]) * 180) / Math.PI);
  const rotation = (((from + degrees) % 360) + 360) % 360;
  p.set({ rotation, turned: true });
  const at = st.ghost?.at ?? keyboardPoint(store);
  if (at !== null) moveGhost(store, at, st.tol === 0 ? defaultTol(store) : st.tol, st.free);
  return true;
}

/** Move the ghost by a step in plan (the arrows while placing). */
export function nudgeGhost(store: EditorStore, dx: number, dy: number): boolean {
  const st = placingOf(store).get();
  if (st.active === null) return false;
  const at = st.ghost?.at ?? keyboardPoint(store);
  if (at === null) return false;
  moveGhost(store, [at[0] + dx, at[1] + dy], st.tol === 0 ? defaultTol(store) : st.tol, true);
  return true;
}

/** Place the entry's ghost as it shows: one batch. The place tool stays on for the next. */
export async function placeHere(store: EditorStore, key: string | null = placingOf(store).get().active, ghost: Ghost | null = placingOf(store).get().ghost): Promise<boolean> {
  const entry = entryOf(store, key);
  if (entry === undefined) return false;
  if (ghost === null) {
    store.set({ notice: { tone: 'info', text: entry.placement === 'opening' ? 'Point at a wall to put it in.' : entry.placement === 'device' || entry.placement === 'wall' ? 'Point at a wall, a floor or a ceiling.' : 'Point at where it goes.' } });
    return false;
  }
  const p = placingOf(store);
  p.set({ busy: p.get().busy + 1 });
  try {
    const ok = await placeGhost(store, entry, ghost);
    if (ok) pushRecent(store, entry.key);
    return ok;
  } finally {
    p.set({ busy: p.get().busy - 1 });
  }
}

// ─── Dragging a card onto the plan ────────────────────────────────────────────────────────────

/** The plan's <svg> and where a client point is on it, in plan; null off it. */
export function planPointAt(store: EditorStore, x: number, y: number): Point | null {
  const svg = document.querySelector<SVGSVGElement>('.fs-canvas__svg');
  const view = store.get().view;
  if (svg === null || view === null) return null;
  const r = svg.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  // Over a drawer that covers the plan is not over the plan.
  const top = document.elementFromPoint(x, y);
  if (top !== null && top.closest('.fs-canvas') === null) return null;
  return toWorld(view, [x - r.left, y - r.top]);
}

export function dragStart(store: EditorStore, key: string, x: number, y: number): void {
  const p = placingOf(store);
  if (p.get().active !== key) p.set({ rotation: 0, turned: false });
  p.set({ dragging: { key, x, y, over: false }, ghost: null });
}

export function dragMove(store: EditorStore, x: number, y: number, touch: boolean): void {
  const p = placingOf(store);
  const d = p.get().dragging;
  if (d === null) return;
  const at = planPointAt(store, x, y);
  const view = store.get().view;
  p.set({ dragging: { ...d, x, y, over: at !== null } });
  if (at === null || view === null) {
    if (p.get().ghost !== null) p.set({ ghost: null });
    return;
  }
  store.set({ cursor: at });
  moveGhost(store, at, (touch ? 22 : 8) / view.s, false);
}

/** Let go: over the plan, it is placed where the ghost shows; anywhere else, nothing happens. */
export async function dragEnd(store: EditorStore, cancelled = false): Promise<boolean> {
  const p = placingOf(store);
  const d = p.get().dragging;
  const ghost = p.get().ghost;
  p.set({ dragging: null, ...(p.get().active === null ? { ghost: null } : {}) });
  if (cancelled || d === null || !d.over || ghost === null) return false;
  return placeHere(store, d.key, ghost);
}

// ─── The quick-add bar ────────────────────────────────────────────────────────────────────────

/** Open the quick-add bar (/), placing at the pointer — or the middle of the view. */
export function openQuickAdd(store: EditorStore): void {
  const s = store.get();
  if (s.readOnly !== null || s.level === null) return;
  const at = keyboardPoint(store);
  if (at === null) return;
  const p = placingOf(store);
  p.set({ quick: { query: '', index: 0, at }, quickKey: null, rotation: 0, turned: false });
}

export function closeQuickAdd(store: EditorStore): void {
  const p = placingOf(store);
  p.set({ quick: null, quickKey: null, ...(p.get().active === null ? { ghost: null } : {}) });
}

/** The quick-add bar's highlighted entry, ghosted where it would go. */
export function quickPreview(store: EditorStore, entry: Entry | undefined): void {
  const p = placingOf(store);
  const q = p.get().quick;
  if (q === null) return;
  p.set({ quickKey: entry?.key ?? null, ghost: entry === undefined ? null : computeGhost(store, entry, q.at, defaultTol(store) * 2, false) });
}

/** Enter in the quick-add bar: place it at the pointer; with ⇧, then keep placing it. */
export async function quickPlace(store: EditorStore, entry: Entry, repeat: boolean): Promise<boolean> {
  const p = placingOf(store);
  const q = p.get().quick;
  if (q === null) return false;
  const ghost = computeGhost(store, entry, q.at, defaultTol(store) * 2, false);
  p.set({ quick: null, quickKey: null });
  if (repeat) startPlacing(store, entry.key);
  else p.set({ ghost: null });
  return placeHere(store, entry.key, ghost);
}
