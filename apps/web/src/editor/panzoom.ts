import { useSyncExternalStore } from 'react';
import type { EditorStore, Viewport } from './store';
import type { LevelView, Point } from './model';
import { levelOfElement } from './model';
import { boundsOf } from './geometry';
import { fit, scaleForPercent, visibleRegion, zoomAt, zoomPercent } from './viewport';

/**
 * Pan and zoom made easy (FLR-T-18.6), after the board's "18.6 · Pan and zoom" frame: the zoom
 * menu (type a zoom; fit ⇧1, selection ⇧2, 100% ⇧0; 50, 200, 400%; what a plain scroll wheel
 * does), a 2D minimap with the view's rectangle to drag, named saved views, and selecting an element
 * from the tree, the palette, a finding or a proposal moving the view to it.
 *
 * The view moves by animation — 220 ms, eased out — and at once under reduced motion. An animation
 * gives way to the person: the moment anything else moves the view (a drag, a scroll, a pinch), it
 * stops where it is.
 *
 * Like the drawers and the 3D view, this state lives beside the editor's store, not in it; what is
 * kept between visits (the wheel's behaviour, the minimap, the saved views) is kept in this browser.
 */

export type WheelMode = 'auto' | 'zoom' | 'pan';
export const WHEEL_LABELS: Record<WheelMode, string> = { zoom: 'Zoom', pan: 'Pan', auto: 'Auto' };
export const WHEEL_HELP: Record<WheelMode, string> = {
  auto: 'Auto: trackpads pan and pinch-zoom; mouse wheels zoom.',
  zoom: 'Zoom: the wheel zooms; ⇧ scrolls sideways; a trackpad pinch zooms too.',
  pan: 'Pan: the wheel scrolls the plan; ⌘ or Ctrl with the wheel, or a pinch, zooms.',
};

/** A named 2D view of a project (level, mode, zoom and region), kept in this browser. */
export interface SavedView {
  id: string;
  name: string;
  level: string;
  /**
   * The trade mode the view was saved in (FLR-T-18.3: Construction, Decorator, Electrical…), so a
   * saved view brings its mode back once modes exist. Null until then, and for a view saved without one.
   */
  mode: string | null;
  /** The world rectangle the view showed, base units: restored by fitting it to the canvas as it is now. */
  region: { minX: number; minY: number; maxX: number; maxY: number };
  /** The zoom when saved, for its label ("180%"). */
  zoom: number;
  /** Saved fitted to its level: restored by fitting the level as it is then. */
  fit: boolean;
}

export interface NavState {
  wheel: WheelMode;
  minimap: boolean;
  /** The saved views panel is open. */
  views: boolean;
  /** A name for a new saved view is being typed (⇧⌘S, or the panel's +). */
  naming: boolean;
  saved: SavedView[];
  /** An animation is moving the view. */
  animating: boolean;
}

const WHEEL_KEY = 'floorspec.wheel';
const MINIMAP_KEY = 'floorspec.minimap';
const viewsKey = (project: string) => `floorspec.views.${project}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = storage()?.getItem(key) ?? null;
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused (a private window, a full quota): kept for this visit only.
  }
}

const isWheel = (v: unknown): v is WheelMode => v === 'auto' || v === 'zoom' || v === 'pan';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isRect = (v: unknown): v is SavedView['region'] =>
  typeof v === 'object' && v !== null && ['minX', 'minY', 'maxX', 'maxY'].every((k) => Number.isFinite((v as Record<string, unknown>)[k]));
const isSaved = (v: unknown): v is SavedView[] =>
  Array.isArray(v) &&
  v.every((x: unknown) => {
    if (typeof x !== 'object' || x === null) return false;
    const r = x as Record<string, unknown>;
    return typeof r['id'] === 'string' && typeof r['name'] === 'string' && typeof r['level'] === 'string' && (r['mode'] === null || typeof r['mode'] === 'string') && isRect(r['region']) && typeof r['zoom'] === 'number' && typeof r['fit'] === 'boolean';
  });

export class NavStore {
  private state: NavState;
  private readonly listeners = new Set<() => void>();
  /** A level the view has been placed on for, so the canvas does not frame it again on arrival. */
  private placed: string | null = null;
  private frame = 0;
  /** The view an animation last set, to tell when something else moved it. */
  private lastSet: Viewport | null = null;
  /** Where the running animation is going, so wheel notches add up. */
  target: Viewport | null = null;

  constructor(private readonly store: EditorStore) {
    this.state = {
      wheel: readJson(WHEEL_KEY, 'auto', isWheel),
      minimap: readJson(MINIMAP_KEY, false, isBool),
      views: false,
      naming: false,
      saved: readJson(viewsKey(store.projectId), [], isSaved),
      animating: false,
    };
  }

  get = (): NavState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private patch(p: Partial<NavState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  setWheel(wheel: WheelMode): void {
    write(WHEEL_KEY, wheel);
    this.patch({ wheel });
  }

  setMinimap(minimap: boolean): void {
    write(MINIMAP_KEY, minimap);
    this.patch({ minimap });
  }

  setViews(views: boolean): void {
    this.patch(views ? { views } : { views, naming: false });
  }

  setNaming(naming: boolean): void {
    this.patch(naming ? { naming, views: true } : { naming });
  }

  setSaved(saved: SavedView[]): void {
    write(viewsKey(this.store.projectId), saved);
    this.patch({ saved });
  }

  /** The view has been placed for `level`; the canvas's arrival on it should not frame it again. */
  place(level: string): void {
    this.placed = level;
  }

  /** Whether the view was placed for `level` (and forget it). */
  claim(level: string | null): boolean {
    const hit = level !== null && this.placed === level;
    this.placed = null;
    return hit;
  }

  /** Move the view to `to`: animated, or at once under reduced motion or when asked. */
  animateTo(to: Viewport, options: { anchor?: Point; instant?: boolean } = {}): void {
    const from = this.store.get().view;
    if (from === null) return;
    this.stop();
    if (options.instant === true || reducedMotion() || typeof requestAnimationFrame === 'undefined') {
      this.store.set({ view: { ...to, w: from.w, h: from.h } });
      return;
    }
    const start = performance.now();
    this.target = to;
    this.patch({ animating: true });
    const step = (now: number) => {
      const current = this.store.get().view;
      // Something else moved the view (a drag, a scroll, a pinch): the person wins.
      if (current === null || (this.lastSet !== null && !sameView(current, this.lastSet))) {
        this.finish();
        return;
      }
      const t = Math.min(1, (now - start) / ANIMATION_MS);
      const next = between(from, to, easeOut(t), options.anchor);
      const view = { ...next, w: current.w, h: current.h };
      this.lastSet = view;
      this.store.set({ view });
      if (t < 1) this.frame = requestAnimationFrame(step);
      else this.finish();
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Stop a running animation where it is. */
  stop(): void {
    if (this.frame !== 0 && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);
    this.finish();
  }

  private finish(): void {
    this.frame = 0;
    this.lastSet = null;
    this.target = null;
    if (this.state.animating) this.patch({ animating: false });
  }
}

export const ANIMATION_MS = 220;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const sameView = (a: Viewport, b: Viewport) => a.cx === b.cx && a.cy === b.cy && a.s === b.s;

/**
 * The view a fraction `t` of the way from `a` to `b`: the scale in proportion (logarithmically, so a
 * zoom feels even), and either the centre in a straight line or — zooming about a point on screen —
 * the world point under it held still.
 */
export function between(a: Viewport, b: Viewport, t: number, anchor?: Point): Viewport {
  const s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * t);
  if (anchor !== undefined) {
    // The world point under the anchor at the start; keep it there at every step.
    const wx = (anchor[0] - a.w / 2) / a.s + a.cx;
    const wy = (a.h / 2 - anchor[1]) / a.s + a.cy;
    return { ...a, s, cx: wx - (anchor[0] - a.w / 2) / s, cy: wy - (a.h / 2 - anchor[1]) / s };
  }
  return { ...a, s, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
}

export function reducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const stores = new WeakMap<EditorStore, NavStore>();

export function navOf(store: EditorStore): NavStore {
  let nav = stores.get(store);
  if (nav === undefined) {
    nav = new NavStore(store);
    stores.set(store, nav);
  }
  return nav;
}

export function useNav<T>(store: EditorStore, selector: (s: NavState) => T): T {
  const nav = navOf(store);
  const snapshot = (): T => selector(nav.get());
  return useSyncExternalStore(nav.subscribe, snapshot, snapshot);
}

// ─── The wheel ───────────────────────────────────────────────────────────────────────────────

export type WheelDevice = 'mouse' | 'trackpad';

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  /** Chromium and WebKit's legacy wheelDeltaY, when the browser gives it. */
  wheelDeltaY?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Tells a trackpad from a mouse wheel, one event at a time, with a short memory: a trackpad's
 * stream of events (and its momentum) stays a trackpad's even when one event in it looks like a notch.
 *
 * - Lines or pages (deltaMode 1, 2) are a wheel: Firefox reports a mouse that way.
 * - Any sideways movement is a trackpad: a plain wheel only goes up and down.
 * - Chromium and WebKit give a trackpad's legacy wheelDeltaY as exactly −3 × deltaY, and a wheel's
 *   as whole notches of 120.
 * - Otherwise a whole step of 50 px or more is a notch; small or fractional steps are a trackpad.
 */
export class WheelDetector {
  private last: { device: WheelDevice; at: number } | null = null;

  classify(e: WheelSample, now: number): WheelDevice {
    const device = this.guess(e, now);
    this.last = { device, at: now };
    return device;
  }

  private guess(e: WheelSample, now: number): WheelDevice {
    if (e.deltaMode !== 0) return 'mouse';
    if (e.deltaX !== 0) return 'trackpad';
    if (this.last?.device === 'trackpad' && now - this.last.at < 300) return 'trackpad';
    const legacy = e.wheelDeltaY;
    if (legacy !== undefined && legacy !== 0) {
      if (legacy === -3 * e.deltaY) return 'trackpad';
      if (Math.abs(legacy) % 120 === 0) return 'mouse';
    }
    return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50 ? 'mouse' : 'trackpad';
  }
}

/** What a wheel event does to the view, by the setting and the device it came from. */
export function wheelAction(mode: WheelMode, e: WheelSample, device: WheelDevice): 'zoom' | 'pan' {
  // A pinch arrives as a wheel with Ctrl held; ⌘ or Ctrl with the wheel zooms in every mode.
  if (e.ctrlKey || e.metaKey) return 'zoom';
  if (mode === 'zoom') return e.shiftKey ? 'pan' : 'zoom';
  if (mode === 'pan') return 'pan';
  return device === 'mouse' && !e.shiftKey ? 'zoom' : 'pan';
}

// ─── Moving the view ─────────────────────────────────────────────────────────────────────────

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** The extent of one element on a level, base units; null when it is not drawn there. */
export function elementBounds(level: LevelView, id: string): Bounds | null {
  const wall = level.walls.find((w) => w.id === id);
  if (wall !== undefined) return boundsOf(wall.ring);
  const face = level.faces.find((f) => f.room === id);
  if (face !== undefined) return boundsOf(face.outer);
  const room = level.rooms.find((r) => r.id === id);
  if (room !== undefined) return boundsOf(room.outer);
  const opening = level.openings.find((o) => o.id === id);
  if (opening !== undefined) return boundsOf([opening.start, opening.end]);
  const slab = level.slabs.find((s) => s.id === id);
  if (slab !== undefined) return boundsOf(slab.outline);
  const sep = level.separators.find((s) => s.id === id);
  if (sep !== undefined) return boundsOf(sep.line);
  const junction = level.junctions.find((j) => j.id === id);
  if (junction !== undefined) return boundsOf([junction.position]);
  const device = level.devices.find((d) => d.id === id);
  if (device !== undefined) return boundsOf(device.footprint);
  const roof = level.roofs.find((r) => r.id === id);
  if (roof !== undefined) return boundsOf(roof.derived.outline);
  const stair = level.stairs.find((s) => s.id === id);
  if (stair !== undefined) {
    const { min, max } = stair.derived.box;
    return { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] };
  }
  return null;
}

/** The selected elements, as IDs. */
export function selectedIds(store: EditorStore): string[] {
  const selection = store.get().selection as string | readonly string[] | null;
  if (selection === null) return [];
  return typeof selection === 'string' ? [selection] : [...selection];
}

const union = (all: (Bounds | null)[]): Bounds | null => {
  const some = all.filter((b): b is Bounds => b !== null);
  if (some.length === 0) return null;
  return { minX: Math.min(...some.map((b) => b.minX)), minY: Math.min(...some.map((b) => b.minY)), maxX: Math.max(...some.map((b) => b.maxX)), maxY: Math.max(...some.map((b) => b.maxY)) };
};

const PAD = 72;

/** ⇧1: the level, fitted. */
export function zoomToFit(store: EditorStore): void {
  const { view } = store.get();
  if (view !== null) navOf(store).animateTo(fit(store.levelView?.bounds ?? null, view.w, view.h));
}

/** ⇧2: the selection, fitted — no closer than 400%, so a junction is not a screenful. */
export function zoomToSelection(store: EditorStore): boolean {
  const { view } = store.get();
  const level = store.levelView;
  if (view === null || level === undefined) return false;
  const bounds = union(selectedIds(store).map((id) => elementBounds(level, id)));
  if (bounds === null) return false;
  const framed = fit(bounds, view.w, view.h, Math.min(PAD * 2, view.w / 4, view.h / 4));
  navOf(store).animateTo({ ...framed, s: Math.min(framed.s, scaleForPercent(400)) });
  return true;
}

/** Zoom to a percentage (⇧0 for 100%) about the middle of the canvas, or a point on it. */
export function zoomToPercent(store: EditorStore, percent: number, at?: Point): void {
  const { view } = store.get();
  if (view === null) return;
  const base = navOf(store).target ?? view;
  const point = at ?? [view.w / 2, view.h / 2];
  navOf(store).animateTo(zoomAt(base, scaleForPercent(percent) / base.s, point), { anchor: point });
}

/** Zoom in or out by a factor about a point: + and −, a double click, a wheel notch. */
export function zoomBy(store: EditorStore, factor: number, at?: Point, options: { instant?: boolean } = {}): void {
  const { view } = store.get();
  if (view === null) return;
  const nav = navOf(store);
  // Notches arriving while one animates add up from where it is going.
  const base = nav.target ?? view;
  const point = at ?? [view.w / 2, view.h / 2];
  nav.animateTo(zoomAt(base, factor, point), { anchor: point, ...options });
}

/** The zoom steps + and − and the menu's presets snap to when they pass one. */
export const PRESETS = [50, 100, 200, 400] as const;

/**
 * Bring an element into view: on its level, centred if any part of it is out of the view (or
 * hidden behind its edge), and zoomed out only as far as it takes to show it whole. An element
 * already in view does not move the view.
 */
export function revealElement(store: EditorStore, id: string, options: { instant?: boolean } = {}): void {
  const s = store.get();
  const model = s.model;
  if (model === null || s.view === null) return;
  const levelId = levelOfElement(model, id) ?? s.level;
  const level = model.levels.find((l) => l.id === levelId);
  if (level === undefined) return;
  const bounds = elementBounds(level, id);
  if (bounds === null) return;
  const view = s.view;
  const nav = navOf(store);
  const margin = 48;
  const shown = visibleRegion({ ...view, w: view.w - 2 * margin, h: view.h - 2 * margin });
  const arriving = level.id !== s.level;
  if (!arriving && options.instant !== true && bounds.minX >= shown.minX && bounds.maxX <= shown.maxX && bounds.minY >= shown.minY && bounds.maxY <= shown.maxY) return;
  const framed = fit(bounds, view.w, view.h, PAD * 2);
  const to: Viewport = { ...view, cx: framed.cx, cy: framed.cy, s: Math.min(view.s, framed.s) };
  if (arriving) {
    // Another level: the canvas would frame the whole level as it arrives; the element is the view instead.
    nav.place(level.id);
    store.setLevel(level.id);
    nav.animateTo(to, { instant: true });
    return;
  }
  nav.animateTo(to, options);
}

/**
 * Select an element from somewhere other than the plan — the tree, the palette's "Go to", a
 * finding, a proposal — and move the view to it.
 */
export function goTo(store: EditorStore, id: string, options: { keepSide?: boolean } = {}): void {
  const before = store.get().level;
  store.select(id, options);
  const after = store.get().level;
  // select() moved to the element's level: that arrival is the reveal's, not the canvas's fit, and
  // the view jumps there rather than sliding across from the other level.
  const arrived = after !== null && after !== before;
  if (arrived) navOf(store).place(after);
  revealElement(store, id, arrived ? { instant: true } : {});
}

/** Frame a world rectangle on a level (a finding's shapes): switching to the level if it must. */
export function frameOn(store: EditorStore, level: string | null, bounds: Bounds, pad: number): void {
  const s = store.get();
  if (s.view === null) return;
  const to = fit(bounds, s.view.w, s.view.h, pad);
  if (level !== null && level !== s.level && s.model?.levels.some((l) => l.id === level) === true) {
    navOf(store).place(level);
    store.setLevel(level);
    navOf(store).animateTo(to, { instant: true });
    return;
  }
  navOf(store).animateTo(to);
}

// ─── Saved views ─────────────────────────────────────────────────────────────────────────────

/** A name for the view as it is: its level and zoom, or the level's name alone when it is fitted. */
export function suggestedName(store: EditorStore): string {
  const s = store.get();
  const level = store.levelView?.name ?? 'Plan';
  const saved = navOf(store).get().saved;
  const base = s.view === null ? level : isFitted(store) ? `${level} — whole level` : `${level} · ${String(zoomPercent(s.view))}%`;
  let name = base;
  for (let n = 2; saved.some((v) => v.name === name); n++) name = `${base} (${String(n)})`;
  return name;
}

/** The view is the level fitted, near enough. */
export function isFitted(store: EditorStore): boolean {
  const view = store.get().view;
  if (view === null) return false;
  const fitted = fit(store.levelView?.bounds ?? null, view.w, view.h);
  return Math.abs(fitted.s / view.s - 1) < 0.01 && Math.abs(fitted.cx - view.cx) * view.s < 2 && Math.abs(fitted.cy - view.cy) * view.s < 2;
}

let counter = 0;

/** ⇧⌘S: open the saved views with a name for this view ready to type. */
export function saveViewSoon(store: EditorStore): void {
  navOf(store).setNaming(true);
}

/** Save the view as it is under a name. */
export function saveView(store: EditorStore, name: string, mode: string | null = null): SavedView | null {
  const s = store.get();
  if (s.view === null || s.level === null) return null;
  counter += 1;
  const view: SavedView = {
    id: `v${Date.now().toString(36)}${String(counter)}`,
    name: name.trim() === '' ? suggestedName(store) : name.trim(),
    level: s.level,
    mode,
    region: visibleRegion(s.view),
    zoom: zoomPercent(s.view),
    fit: isFitted(store),
  };
  const nav = navOf(store);
  nav.setSaved([...nav.get().saved, view]);
  return view;
}

export function removeView(store: EditorStore, id: string): void {
  const nav = navOf(store);
  nav.setSaved(nav.get().saved.filter((v) => v.id !== id));
}

export function renameView(store: EditorStore, id: string, name: string): void {
  const nav = navOf(store);
  if (name.trim() === '') return;
  nav.setSaved(nav.get().saved.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)));
}

/** Go to a saved view: its level, and its region fitted to the canvas as it is now (or its level fitted). */
export function openView(store: EditorStore, saved: SavedView): boolean {
  const s = store.get();
  const level = s.model?.levels.find((l) => l.id === saved.level);
  if (s.view === null || level === undefined) return false;
  const to = saved.fit ? fit(level.bounds, s.view.w, s.view.h) : fit(saved.region, s.view.w, s.view.h, 0);
  const nav = navOf(store);
  if (saved.level !== s.level) {
    nav.place(saved.level);
    store.setLevel(saved.level);
    nav.animateTo(to, { instant: true });
  } else nav.animateTo(to);
  return true;
}
