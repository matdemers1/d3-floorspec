import { useSyncExternalStore } from 'react';
import type { EditorStore } from './store';
import { threeOf, type ViewMode } from './three/mode';

/**
 * Full screen and the edge drawers (FLR-T-18.2), after the board's "P18 · 2D editor" frames and
 * the drawer spec (18.2 · Edge drawers — states, timing and input). Three drawers — left (tools and
 * the project tree), top (the top bar), right (the inspector and what takes its place) — each in
 * one of four states:
 *
 *   hidden  ─ pointer rests 120 ms in the edge's 20 px hot zone ─▶ peeking
 *   peeking ─ the pointer moves onto it ─▶ open
 *   open    ─ the pointer is off it for 300 ms ─▶ hidden (never while a field in it has focus or a
 *             menu from it is open)
 *   any     ─ pinned ─▶ pinned: docked flush, the plan reflows
 *
 * The same drawers serve the 2D plan, 3D and split, in full screen and out of it: outside full
 * screen they start pinned (the familiar layout), so collapsing a side panel on a desktop is
 * unpinning it. Which drawers are pinned is remembered per project and per view.
 *
 * The machine is plain TypeScript with an injectable clock, so its timings are tested with fake
 * timers (test/drawers.test.ts); the DOM wiring is in EdgeDrawers.tsx.
 */

export type Side = 'left' | 'top' | 'right';
export const SIDES: readonly Side[] = ['left', 'top', 'right'];
export type DrawerState = 'hidden' | 'peeking' | 'open' | 'pinned';

/** The spec's numbers. */
export const DRAWER_TIMING = {
  /** The pointer rests this long in a hot zone before the drawer peeks. */
  peek: 120,
  /** The pointer is off an open drawer this long before it slides away. */
  leave: 300,
  /** The entering-full-screen and pinned notices fade after this long. */
  notice: 2500,
} as const;

/** Hot zones: 20 px from the edge, 28 px on a coarse pointer. */
export const HOT_ZONE = { fine: 20, coarse: 28 } as const;

/** An edge swipe: this far in peeks, this far opens. */
export const SWIPE = { peek: 12, open: 72 } as const;

export const SIDE_NAMES: Record<Side, string> = { left: 'Left drawer', top: 'Top drawer', right: 'Right drawer' };

/** The keys that summon each drawer (⌘ on macOS, Ctrl elsewhere), as the board's read-me gives them. */
export const DRAWER_HINTS: Record<Side, string> = { left: '⌘\\', top: '⌘⌥\\', right: '⌘⇧\\' };
/** The same keys one by one, for <kbd>s. */
export const DRAWER_KEYS: Record<Side, readonly string[]> = { left: ['⌘', '\\'], top: ['⌘', '⌥', '\\'], right: ['⌘', '⇧', '\\'] };

/** A box on the screen, in client pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const within = (box: Box, x: number, y: number): boolean => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/**
 * Where the pointer is against a drawer, measured rather than heard: on its box, off it, or not yet
 * known because the drawer is still sliding.
 */
export type Measure = 'on' | 'off' | 'moving';

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** The global timers, looked up at call time so fake timers in a test replace them. */
export const realClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => { globalThis.clearTimeout(id as ReturnType<typeof setTimeout>); },
};

/** One drawer's state machine. */
export class DrawerMachine {
  private current: DrawerState = 'hidden';
  /** The pointer is over the drawer. */
  private over = false;
  /** The pointer is in the drawer's hot zone. */
  private inZone = false;
  /** A field in the drawer has focus, or a menu from it is open: it stays. */
  private held = false;
  private timer: unknown = null;
  private pending: 'peek' | 'leave' | null = null;
  /**
   * Where the pointer is, measured, asked when the 300 ms walk-away runs out (FLR-T-18.17): the
   * pointer may have reached the drawer without the drawer hearing it (see `measured`).
   */
  probe: (() => Measure) | null = null;

  constructor(
    private readonly onChange: (state: DrawerState) => void,
    private readonly clock: Clock = realClock,
  ) {}

  get state(): DrawerState {
    return this.current;
  }

  /** What a timer is waiting to do, for tests and for the grip's brightness. */
  get waiting(): 'peek' | 'leave' | null {
    return this.pending;
  }

  private go(next: DrawerState): void {
    this.cancel();
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }

  private cancel(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private after(kind: 'peek' | 'leave', ms: number, fn: () => void): void {
    this.cancel();
    this.pending = kind;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pending = null;
      fn();
    }, ms);
  }

  /**
   * Start the 300 ms walk-away, unless something holds the drawer or the pointer is on it. When it
   * runs out the pointer's place is measured once more: on the drawer, it was never off it (it
   * opens, if a peek); with the drawer still sliding in, it waits another 300 ms.
   */
  private leaveSoon(): void {
    if (this.held || this.over) return;
    if (this.current !== 'open' && this.current !== 'peeking') return;
    if (this.pending === 'leave') return;
    this.after('leave', DRAWER_TIMING.leave, () => {
      const at = this.probe?.() ?? 'off';
      if (at === 'on') this.enter();
      else if (at === 'moving') this.leaveSoon();
      else this.go('hidden');
    });
  }

  /** The pointer came into the hot zone. */
  zoneEnter(): void {
    if (this.inZone) return;
    this.inZone = true;
    if (this.current === 'hidden') this.after('peek', DRAWER_TIMING.peek, () => { this.go('peeking'); });
    else if (this.current === 'peeking' && this.pending === 'leave') this.cancel();
  }

  /** The pointer left the hot zone: onto the peek, which opens it, or away, which lets it go. */
  zoneLeave(): void {
    if (!this.inZone) return;
    this.inZone = false;
    if (this.current === 'hidden' && this.pending === 'peek') this.cancel();
    else if (this.current === 'peeking') {
      if (this.over) this.go('open');
      else this.leaveSoon();
    }
  }

  /**
   * The pointer is over the drawer. A peek opens once the pointer is on it past the hot zone — a
   * peek sliding in under a pointer resting at the edge is not the pointer moving onto it. An open
   * drawer stops leaving.
   */
  enter(): void {
    this.over = true;
    if (this.current === 'peeking' && !this.inZone) this.go('open');
    else if ((this.current === 'open' || this.current === 'peeking') && this.pending === 'leave') this.cancel();
  }

  /** The pointer moved off the drawer. */
  leave(): void {
    this.over = false;
    if (this.inZone && this.current === 'peeking') return;
    this.leaveSoon();
  }

  /** The pointer is over the drawer, as far as the drawer has heard. */
  get hovered(): boolean {
    return this.over;
  }

  /**
   * A pointermove measured against the drawer's box (FLR-T-18.17). The drawer's own pointerenter
   * and pointerleave are boundary events, and the browser can skip them: content swapped under a
   * resting pointer, or a drawer sliding in under it during a long frame, leaves its hover state
   * behind, and the move onto the peek then crosses no boundary. On the box counts as entering;
   * off it with the pointer over the plan (`surface`) counts as leaving — off it over something
   * else, a menu or tooltip from the drawer, is left to the drawer's own events.
   */
  measured(on: boolean, surface: boolean): void {
    if (on) this.enter();
    else if (this.over && surface) this.leave();
  }

  /** A field in the drawer took focus or a menu from it opened (true), or that ended (false). */
  hold(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    if (on) {
      if (this.pending === 'leave') this.cancel();
    } else this.leaveSoon();
  }

  /** Open it without the pointer — the keyboard, a command, or the panel's content asking to be seen. */
  open(): void {
    if (this.current === 'pinned') return;
    this.go('open');
  }

  /** Close it now (Esc, a click on the plan); a pinned drawer stays. */
  close(): void {
    if (this.current === 'pinned') return;
    this.over = false;
    this.go('hidden');
  }

  /** A click on the plan: a floating drawer goes now, unless a field or menu in it holds it. */
  dismiss(): void {
    if (this.held || (this.current !== 'open' && this.current !== 'peeking')) return;
    this.close();
  }

  /** Pin it (docked), or unpin it — it stays open while the pointer is on it, then leaves. */
  pin(on: boolean): void {
    if (on) {
      this.go('pinned');
      return;
    }
    if (this.current !== 'pinned') return;
    this.go('open');
    this.leaveSoon();
  }

  /**
   * The drawer's shortcut: hidden or peeking → open (and the caller moves focus in); open →
   * pinned; pinned → hidden. Returns the new state.
   */
  cycle(): DrawerState {
    if (this.current === 'hidden' || this.current === 'peeking') this.go('open');
    else if (this.current === 'open') this.go('pinned');
    else {
      this.over = false;
      this.go('hidden');
    }
    return this.current;
  }

  /** A touch or pen swipe in from the edge, `distance` px so far. */
  swipe(distance: number): void {
    if (this.current === 'pinned' || this.current === 'open') return;
    if (distance >= SWIPE.open) this.go('open');
    else if (distance >= SWIPE.peek && this.current === 'hidden') this.go('peeking');
  }

  /** Start over in a new context (full screen entered or left, another view): pinned or hidden. */
  reset(pinned: boolean): void {
    this.over = false;
    this.inZone = false;
    this.held = false;
    this.go(pinned ? 'pinned' : 'hidden');
  }

  dispose(): void {
    this.cancel();
  }
}

// ─── The editor's drawers ─────────────────────────────────────────────────────────────────────

export type DrawerNotice = { id: number; kind: 'full' } | { id: number; kind: 'pinned'; side: Side };

export interface DrawersState {
  /** Full screen: the chrome hidden, the drawers summoned from the edges. */
  full: boolean;
  left: DrawerState;
  top: DrawerState;
  right: DrawerState;
  /** The hot zone the pointer is in, so its grip brightens. */
  zone: Side | null;
  notice: DrawerNotice | null;
}

/** Where pins are remembered: one record per project, keyed by full screen or not and the view. */
export interface PinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Pins = Partial<Record<Side, boolean>>;

const storageKey = (projectId: string) => `floorspec.drawers.${projectId}`;

function browserStorage(): PinStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class DrawersStore {
  private state: DrawersState = { full: false, left: 'pinned', top: 'pinned', right: 'pinned', zone: null, notice: null };
  private readonly listeners = new Set<() => void>();
  private readonly machines: Record<Side, DrawerMachine>;
  private view: ViewMode = 'plan';
  private noticeTimer: unknown = null;
  private noticeId = 0;
  /** The Fullscreen API was asked and granted for this full screen. */
  native = false;

  constructor(
    readonly projectId: string,
    private readonly clock: Clock = realClock,
    private readonly storage: PinStorage | null = browserStorage(),
  ) {
    const machine = (side: Side) => new DrawerMachine((next) => { this.patch({ [side]: next }); }, clock);
    this.machines = { left: machine('left'), top: machine('top'), right: machine('right') };
    this.apply();
  }

  get = (): DrawersState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(next: Partial<DrawersState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  machine(side: Side): DrawerMachine {
    return this.machines[side];
  }

  /** The context pins are remembered in. */
  get context(): string {
    return `${this.state.full ? 'full' : 'windowed'}:${this.view}`;
  }

  private readPins(): Record<string, Pins> {
    try {
      const raw = this.storage?.getItem(storageKey(this.projectId));
      const parsed: unknown = raw === null || raw === undefined ? {} : JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Pins>) : {};
    } catch {
      return {};
    }
  }

  /** Pinned in the current context: as remembered, else pinned outside full screen and not in it. */
  pinnedFor(side: Side): boolean {
    return this.readPins()[this.context]?.[side] ?? !this.state.full;
  }

  private remember(side: Side, pinned: boolean): void {
    const all = this.readPins();
    all[this.context] = { ...all[this.context], [side]: pinned };
    try {
      this.storage?.setItem(storageKey(this.projectId), JSON.stringify(all));
    } catch {
      // Storage refused (a private window): the pin lasts for this visit.
    }
  }

  /** Put every drawer in the state the current context remembers. */
  private apply(): void {
    for (const side of SIDES) this.machines[side].reset(this.pinnedFor(side));
    const m = this.machines;
    this.patch({ left: m.left.state, top: m.top.state, right: m.right.state, zone: null });
  }

  private notify(notice: { kind: 'full' } | { kind: 'pinned'; side: Side }): void {
    if (this.noticeTimer !== null) this.clock.clearTimeout(this.noticeTimer);
    this.noticeId += 1;
    this.patch({ notice: { ...notice, id: this.noticeId } });
    this.noticeTimer = this.clock.setTimeout(() => {
      this.noticeTimer = null;
      this.patch({ notice: null });
    }, DRAWER_TIMING.notice);
  }

  /** The view (2D, 3D, split) changed: its own pins apply. */
  setView(view: ViewMode): void {
    if (view === this.view) return;
    this.view = view;
    this.apply();
  }

  setFull(full: boolean): void {
    if (full === this.state.full) return;
    this.patch({ full });
    this.apply();
    if (full) this.notify({ kind: 'full' });
    else if (this.state.notice?.kind === 'full') this.patch({ notice: null });
  }

  /** Pin or unpin a drawer (its pin button, ⇧-click or a tap on its grip), remembered. */
  setPinned(side: Side, pinned: boolean): void {
    if (pinned) this.machines[side].pin(true);
    else this.machines[side].pin(false);
    this.remember(side, pinned);
    if (pinned) this.notify({ kind: 'pinned', side });
  }

  /** The drawer's shortcut; true when focus should move into it. */
  summon(side: Side): boolean {
    const before = this.machines[side].state;
    const after = this.machines[side].cycle();
    if (after === 'pinned') {
      this.remember(side, true);
      this.notify({ kind: 'pinned', side });
    } else if (before === 'pinned') this.remember(side, false);
    return after === 'open';
  }

  /** Show a drawer without moving focus: the panel's content changed to something to look at. */
  reveal(side: Side): void {
    this.machines[side].open();
  }

  /** Esc in a drawer, or a click on the plan: an unpinned drawer goes. */
  close(side: Side): void {
    this.machines[side].close();
  }

  /** Close every floating drawer nothing holds (a click on the plan). */
  closeFloating(): void {
    for (const side of SIDES) this.machines[side].dismiss();
  }

  /**
   * A pointermove at (x, y), measured against each floating drawer's box — before the hot zone, so
   * a pointer that has reached a peek opens it on leaving the zone (DrawerMachine.measured).
   */
  pointerAt(x: number, y: number, boxOf: (side: Side) => Box | null, surface: boolean): void {
    for (const side of SIDES) {
      const state = this.state[side];
      if (state !== 'peeking' && state !== 'open') continue;
      const box = boxOf(side);
      if (box !== null) this.machines[side].measured(within(box, x, y), surface);
    }
  }

  /** How each drawer measures the pointer when its walk-away runs out (null: it does not). */
  setProbe(probe: ((side: Side) => Measure) | null): void {
    for (const side of SIDES) this.machines[side].probe = probe === null ? null : () => probe(side);
  }

  /** The pointer is in this hot zone (or none): its machine hears it, the others hear it left. */
  pointerZone(zone: Side | null): void {
    for (const side of SIDES) {
      if (side === zone) this.machines[side].zoneEnter();
      else this.machines[side].zoneLeave();
    }
    if (zone !== this.state.zone) this.patch({ zone });
  }

  dispose(): void {
    for (const side of SIDES) this.machines[side].dispose();
    if (this.noticeTimer !== null) this.clock.clearTimeout(this.noticeTimer);
  }
}

/** Which edge's hot zone a point is in, measured against the canvas area; corners go to the nearer edge. */
export function zoneAt(x: number, y: number, area: { left: number; top: number; right: number; bottom: number }, size: number, open: (side: Side) => boolean): Side | null {
  if (x < area.left - 1 || x > area.right + 1 || y < area.top - 1 || y > area.bottom + 1) return null;
  const d: [Side, number][] = [
    ['left', x - area.left],
    ['top', y - area.top],
    ['right', area.right - x],
  ];
  const near = d.filter(([side, dist]) => dist < size && open(side)).sort((a, b) => a[1] - b[1]);
  return near[0]?.[0] ?? null;
}

const stores = new WeakMap<EditorStore, DrawersStore>();

/** The drawers of an editor: one per editor store, made on first use, following its 3D view's mode. */
export function drawersOf(store: EditorStore): DrawersStore {
  let drawers = stores.get(store);
  if (drawers === undefined) {
    const made = new DrawersStore(store.projectId);
    const three = threeOf(store);
    made.setView(three.get().mode);
    three.subscribe(() => { made.setView(three.get().mode); });
    // The tree asked for (F2's rename, the history): a hidden left drawer comes out for it, before
    // the rename field mounts, so its autofocus lands.
    let was = { renaming: store.get().renaming, left: store.get().left };
    store.subscribe(() => {
      const s = store.get();
      if ((s.renaming !== null && s.renaming !== was.renaming) || s.left !== was.left) made.reveal('left');
      was = { renaming: s.renaming, left: s.left };
    });
    stores.set(store, made);
    drawers = made;
  }
  return drawers;
}

export function useDrawers<T>(store: EditorStore, selector: (s: DrawersState) => T): T {
  const drawers = drawersOf(store);
  return useSyncExternalStore(drawers.subscribe, () => selector(drawers.get()));
}

// ─── In the page: focus, the keys, the Fullscreen API ─────────────────────────────────────────

/** Below this width, outside full screen, the tablet layout owns the panels (the tree folds away, the inspector floats). */
export const NARROW = '(max-width: 1199px)';

const narrowNow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;

/** The drawers are the layout: in full screen, or outside it on a desktop-wide window. */
export const drawersActive = (store: EditorStore): boolean => drawersOf(store).get().full || !narrowNow();

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="treeitem"][tabindex="0"]';

const drawerEl = (side: Side): HTMLElement | null => document.querySelector<HTMLElement>(`[data-drawer="${side}"]`);

/** Move focus into a drawer: its pressed control (the tool in use) first, else its first control. */
function focusInside(side: Side): boolean {
  const el = drawerEl(side);
  if (el === null || el.inert) return false;
  const visible = (e: HTMLElement) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  // The tool in use, else the first control that is the drawer's content rather than its pin.
  const content = all.filter((e) => e.closest('.fs-drawer__pin, .fs-rail__pin, .fs-topbar__pin') === null);
  const target = content.find((e) => e.getAttribute('aria-pressed') === 'true') ?? content[0] ?? all[0];
  if (target === undefined) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** Focus into a drawer once it has rendered open; a few frames' grace for the state to land. */
export function focusDrawer(side: Side, tries = 4): void {
  if (typeof document === 'undefined') return;
  if (focusInside(side)) return;
  if (tries > 0) requestAnimationFrame(() => { focusDrawer(side, tries - 1); });
}

/** Esc's destination: the editor's frame, where the plan's keys are read. */
export function focusCanvas(): void {
  if (typeof document === 'undefined') return;
  document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
}

/** The side whose drawer holds an element, if any. */
export function sideOf(el: Element | null): Side | null {
  const side = el?.closest<HTMLElement>('[data-drawer]')?.dataset['drawer'];
  return side === 'left' || side === 'top' || side === 'right' ? side : null;
}

/**
 * ⌘\ · ⌘⌥\ · ⌘⇧\: open that drawer and move focus in; again pins it; again hides it. On a tablet
 * outside full screen ⌘\ folds the project tree in and out, as it always has.
 */
export function summonDrawer(store: EditorStore, side: Side): void {
  if (!drawersActive(store)) {
    if (side === 'left') store.set({ treeOpen: !store.get().treeOpen, left: 'tree' });
    else focusDrawer(side, 0);
    return;
  }
  const drawers = drawersOf(store);
  const inside = sideOf(document.activeElement) === side;
  if (drawers.summon(side)) focusDrawer(side);
  else if (inside && drawers.get()[side] === 'hidden') focusCanvas();
}

/** F6 / ⇧F6: the canvas → left → top → right → the canvas, opening each drawer on the way. */
export function cycleFocus(store: EditorStore, back: boolean): void {
  const order: (Side | 'canvas')[] = ['canvas', 'left', 'top', 'right'];
  const from = sideOf(document.activeElement) ?? 'canvas';
  const drawers = drawersOf(store);
  const active = drawersActive(store);
  for (let step = 1; step < order.length; step++) {
    const i = order.indexOf(from);
    const next = order[(i + (back ? -step : step) + order.length * 2) % order.length] ?? 'canvas';
    if (next === 'canvas') {
      focusCanvas();
      return;
    }
    if (focusInside(next)) return;
    if (active && drawers.get()[next] !== 'pinned') {
      drawers.reveal(next);
      focusDrawer(next);
      return;
    }
  }
  focusCanvas();
}

/** Esc with focus in a drawer: an unpinned drawer closes; in full screen focus goes back to the canvas either way. */
export function escapeDrawer(store: EditorStore, target: Element | null): boolean {
  const side = sideOf(target);
  if (side === null) return false;
  const drawers = drawersOf(store);
  // A docked panel outside full screen keeps Esc for the plan, as it always has.
  if (!drawers.get().full && (!drawersActive(store) || drawers.get()[side] === 'pinned')) return false;
  drawers.close(side);
  focusCanvas();
  return true;
}

/** Full screen on or off: the chrome hides, and the browser goes full screen where it allows it. */
export function setFullScreen(store: EditorStore, on: boolean): void {
  const drawers = drawersOf(store);
  drawers.setFull(on);
  if (typeof document === 'undefined') return;
  if (on && document.fullscreenEnabled && document.fullscreenElement === null) {
    document.documentElement
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        drawers.native = true;
      })
      .catch(() => {
        // Not allowed here (an iframe, a policy): full screen inside the window still works.
      });
  } else if (!on && drawers.native && document.fullscreenElement !== null) {
    drawers.native = false;
    void document.exitFullscreen().catch(() => undefined);
  }
}
