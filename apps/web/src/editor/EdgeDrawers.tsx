import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton, Tooltip } from '@d3cloud/ui';
import { Box, Columns2, Map as MapIcon, Maximize, Minimize, Pin } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import { useThreeState } from './three/mode';
import { zoomPercent } from './viewport';
import { HudMode } from './ModeSwitcher';
import {
  DRAWER_HINTS,
  DRAWER_KEYS,
  HOT_ZONE,
  NARROW,
  SIDE_NAMES,
  SIDES,
  drawersOf,
  setFullScreen,
  sideOf,
  useDrawers,
  zoneAt,
  type DrawerNotice,
  type DrawerState,
  type Side,
} from './drawers';

/**
 * The edge drawers and full screen in the page (FLR-T-18.2): the drawer wrappers, their pin
 * buttons, the edge grips, the hot zones, edge swipes, the quiet HUD and the notices. The state
 * machine and its timings are in drawers.ts.
 */

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => { list.removeEventListener('change', notify); };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * A drawer's state as the page draws it: on a tablet outside full screen the tablet layout owns the
 * panels, so every drawer reads as docked there.
 */
export function useDrawerState(store: EditorStore, side: Side): DrawerState {
  const state = useDrawers(store, (s) => s[side]);
  const full = useDrawers(store, (s) => s.full);
  const narrow = useMedia(NARROW);
  return !full && narrow ? 'pinned' : state;
}

/** The layout attributes the editor's frame carries: which chrome, and each drawer's state. */
export function useChrome(store: EditorStore): Record<string, string> {
  const full = useDrawers(store, (s) => s.full);
  const narrow = useMedia(NARROW);
  const left = useDrawers(store, (s) => s.left);
  const top = useDrawers(store, (s) => s.top);
  const right = useDrawers(store, (s) => s.right);
  const docked = !full && narrow;
  return {
    'data-chrome': full ? 'full' : 'windowed',
    'data-left': docked ? 'pinned' : left,
    'data-top': docked ? 'pinned' : top,
    'data-right': docked ? 'pinned' : right,
  };
}

/** One drawer: a group a shortcut can move focus into, hidden from the keyboard while it is away. */
export function Drawer({ store, side, children }: { store: EditorStore; side: Side; children: ReactNode }) {
  const state = useDrawerState(store, side);
  const full = useDrawers(store, (s) => s.full);
  const narrow = useMedia(NARROW);
  const docked = !full && narrow;
  const machine = drawersOf(store).machine(side);
  return (
    <div
      className={`fs-drawer fs-drawer--${side}`}
      data-drawer={side}
      data-state={state}
      // On the tablet layout the wrapper steps out of the way (display: contents); a group there
      // would name nothing.
      role={docked ? undefined : 'group'}
      aria-label={docked ? undefined : SIDE_NAMES[side]}
      tabIndex={-1}
      inert={state === 'hidden'}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') machine.enter();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch') machine.leave();
      }}
      onPointerDown={(e) => {
        // A tap on a peek opens it.
        if (e.pointerType === 'touch' && state === 'peeking') machine.open();
      }}
    >
      {children}
    </div>
  );
}

/** The pin in a drawer's header: docked, or summoned from the edge. */
export function PinButton({ store, side }: { store: EditorStore; side: Side }) {
  const state = useDrawers(store, (s) => s[side]);
  const pinned = state === 'pinned';
  const hint = DRAWER_HINTS[side];
  return (
    <Tooltip content={pinned ? `Unpin — slide it away to the edge (${hint})` : `Pin — keep it docked (${hint})`} side={side === 'left' ? 'right' : side === 'right' ? 'left' : 'bottom'}>
      <IconButton
        size="sm"
        className="fs-drawer__pin"
        label={`Pin the ${side} drawer`}
        pressed={pinned}
        icon={<Pin />}
        onClick={() => { drawersOf(store).setPinned(side, !pinned); }}
      />
    </Tooltip>
  );
}

/** A side drawer's header: what it holds, and its pin. */
export function DrawerHead({ store, side, title }: { store: EditorStore; side: 'left' | 'right'; title: string }) {
  return (
    <div className="fs-drawer__head">
      <span className="fs-overline">{title}</span>
      <span className="fs-spacer" />
      <PinButton store={store} side={side} />
    </div>
  );
}

/** The top bar's full-screen button: in, or out. */
export function FullScreenButton({ store }: { store: EditorStore }) {
  const full = useDrawers(store, (s) => s.full);
  return (
    <Tooltip content={full ? 'Exit full screen (F or Esc)' : 'Full screen (F)'}>
      <IconButton
        label={full ? 'Exit full screen' : 'Full screen'}
        icon={full ? <Minimize /> : <Maximize />}
        onClick={() => { setFullScreen(store, !full); }}
      />
    </Tooltip>
  );
}

// ─── The edges ─────────────────────────────────────────────────────────────────────────────────

/**
 * Everything at the edges: the grips of hidden drawers, the hot zones (read from the pointer's
 * position over the canvas, so nothing covers the plan), edge swipes, focus holding a drawer open,
 * a click on the plan putting floating drawers away, the Fullscreen API's own exit, and in full
 * screen the HUD and the notices.
 */
export function Edges({ store }: { store: EditorStore }) {
  const drawers = drawersOf(store);
  const full = useDrawers(store, (s) => s.full);
  const zone = useDrawers(store, (s) => s.zone);
  const notice = useDrawers(store, (s) => s.notice);
  const narrow = useMedia(NARROW);
  const coarse = useMedia('(pointer: coarse)');
  const active = full || !narrow;
  const states = useDrawers(store, (s) => `${s.left} ${s.top} ${s.right}`);
  const lastPointer = useRef<string>('mouse');

  useEffect(() => {
    if (!active) {
      drawers.pointerZone(null);
      return;
    }
    const area = () => document.querySelector('.fs-editor__canvas')?.getBoundingClientRect() ?? null;
    const away = (side: Side) => {
      const s = drawers.get()[side];
      return s === 'hidden' || s === 'peeking';
    };
    // Hover: the pointer's place over the canvas area (or a grip) decides the hot zone.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const target = e.target instanceof Element ? e.target : null;
      // Over the canvas or a grip, every edge counts; over a floating drawer, only its own edge.
      const own = target?.closest<HTMLElement>('.fs-drawer:not([data-state="pinned"])')?.dataset['drawer'] ?? null;
      const over = own !== null || (target?.closest('.fs-editor__canvas, .fs-grip') ?? null) !== null;
      const rect = area();
      if (!over || rect === null) {
        drawers.pointerZone(null);
        return;
      }
      const zone = zoneAt(e.clientX, e.clientY, rect, coarse ? HOT_ZONE.coarse : HOT_ZONE.fine, (side) => (own === null || own === side) && away(side));
      drawers.pointerZone(zone);
    };
    // Touch and pen: a swipe in from an edge peeks, then opens. It is the drawer's gesture, not the plan's.
    let swipe: { side: Side; x: number; y: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType;
      const target = e.target instanceof Element ? e.target : null;
      if (e.pointerType !== 'mouse') {
        const rect = area();
        if (rect !== null && target?.closest('.fs-editor__canvas, .fs-grip') !== null) {
          const side = zoneAt(e.clientX, e.clientY, rect, HOT_ZONE.coarse, away);
          if (side !== null) {
            swipe = { side, x: e.clientX, y: e.clientY, id: e.pointerId };
            e.stopPropagation();
            return;
          }
        }
      }
      // A press on the plan puts floating drawers away.
      if (target?.closest('.fs-editor__canvas') !== null && sideOf(target) === null) drawers.closeFloating();
    };
    const onSwipe = (e: PointerEvent) => {
      if (swipe === null || e.pointerId !== swipe.id) return;
      const d = swipe.side === 'left' ? e.clientX - swipe.x : swipe.side === 'top' ? e.clientY - swipe.y : swipe.x - e.clientX;
      drawers.machine(swipe.side).swipe(d);
    };
    const onUp = (e: PointerEvent) => {
      if (swipe !== null && e.pointerId === swipe.id) swipe = null;
    };
    // A field in a drawer, or a menu opened from it (its trigger expanded), holds the drawer open.
    const holds = () => {
      const el = document.activeElement;
      for (const side of SIDES) {
        const box = document.querySelector(`[data-drawer="${side}"]`);
        const field = sideOf(el) === side && el instanceof HTMLElement && el.matches(':focus-visible');
        const menu = box !== null && box.querySelector('[aria-expanded="true"][aria-haspopup], [aria-expanded="true"][role="combobox"]') !== null;
        drawers.machine(side).hold(field || menu);
      }
    };
    const onFocus = () => { setTimeout(holds, 0); };
    const root = document.querySelector<HTMLElement>('.fs-editor');
    window.addEventListener('pointermove', onMove);
    root?.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onSwipe);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onFocus);
    return () => {
      window.removeEventListener('pointermove', onMove);
      root?.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onSwipe);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onFocus);
    };
  }, [drawers, active, coarse]);

  // The browser's own full-screen exit (its Esc, its menu) leaves the editor's full screen too.
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement === null && drawers.native) {
        drawers.native = false;
        if (drawers.get().full) setFullScreen(store, false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      // Leaving the editor leaves full screen.
      if (drawers.get().full) setFullScreen(store, false);
    };
  }, [drawers, store]);

  if (!active) return null;
  const [left, top, right] = states.split(' ') as [DrawerState, DrawerState, DrawerState];
  const away: Record<Side, boolean> = { left: left === 'hidden' || left === 'peeking', top: top === 'hidden' || top === 'peeking', right: right === 'hidden' || right === 'peeking' };
  return (
    <>
      {SIDES.filter((side) => away[side]).map((side) => (
        // A pointer convenience: the shortcuts and F6 are the keyboard's way to every drawer.
        <div
          key={side}
          className={`fs-grip fs-grip--${side}`}
          data-active={zone === side ? 'on' : undefined}
          aria-hidden="true"
          onClick={(e) => {
            // ⇧-click or a tap pins; a click opens.
            if (e.shiftKey || lastPointer.current !== 'mouse') drawers.setPinned(side, true);
            else drawers.reveal(side);
          }}
        >
          <span className="fs-grip__bar" />
        </div>
      ))}
      {full ? <Hud store={store} /> : null}
      <Notice store={store} notice={notice} />
    </>
  );
}

/** Full screen's quiet HUD: the mode (FLR-T-18.3), the view, the level and the zoom. */
function Hud({ store }: { store: EditorStore }) {
  const mode = useThreeState(store, (s) => s.mode);
  const level = useEditor(store, (s) => s.model?.levels.find((l) => l.id === s.level)?.name ?? null);
  const zoom = useEditor(store, (s) => (s.view === null ? null : zoomPercent(s.view)));
  const icon = mode === '3d' ? <Box aria-hidden="true" /> : mode === 'split' ? <Columns2 aria-hidden="true" /> : <MapIcon aria-hidden="true" />;
  return (
    <div className="fs-hud" role="note" aria-label="View">
      <HudMode store={store} />
      {icon}
      <span>{mode === '3d' ? `3D · ${level ?? 'no level'}` : (level ?? 'No level')}</span>
      {mode !== '3d' && zoom !== null ? (
        <>
          <span className="fs-hud__rule" />
          <span className="fs-hud__zoom">{zoom}%</span>
        </>
      ) : null}
    </div>
  );
}

const SIDE_WORD: Record<Side, string> = { left: 'Left', top: 'Top', right: 'Right' };

/** "Full screen. Move to an edge for tools" and "Left drawer pinned", fading after 2.5 s. */
function Notice({ store, notice }: { store: EditorStore; notice: DrawerNotice | null }) {
  const full = useDrawers(store, (s) => s.full);
  if (notice === null) return <div className="fs-fs-notice__live" role="status" />;
  return (
    <div className="fs-fs-notice__live" role="status">
      {notice.kind === 'full' && full ? (
        <div className="fs-fs-notice" key={notice.id}>
          <Maximize aria-hidden="true" />
          <span>Full screen. Move to an edge for tools</span>
          <span className="fs-fs-notice__rule" />
          <kbd>F</kbd>
          <span className="fs-fs-notice__faint">or</span>
          <kbd>Esc</kbd>
          <span className="fs-fs-notice__faint">to exit</span>
        </div>
      ) : notice.kind === 'pinned' ? (
        <div className="fs-fs-notice" key={notice.id}>
          <Pin aria-hidden="true" />
          <span>{SIDE_WORD[notice.side]} drawer pinned</span>
          <span className="fs-fs-notice__rule" />
          {DRAWER_KEYS[notice.side].map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
          <span className="fs-fs-notice__faint">to hide</span>
        </div>
      ) : null}
    </div>
  );
}
