import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { useEditor, type EditorStore, type Viewport } from './store';
import { labelOf, type LevelView } from './model';
import { toScreen } from './viewport';
import { prettyLen, formatLen } from './units';
import { boxOf, handlesOf, isResizable, keyResize, keyRotate, resizeBatch, rotateHandleOf, ruleFor, sizeOf, turnBatch, type HandleSide } from '../furniture/resize';
import { extentAcross, minRoom, resizeRoom, roomSides, type Side } from './rooms/edit';
import { gridStepOf } from './precision/state';
import { drawersOf, focusCanvas } from './drawers';
import type { DeviceView } from './systems/view';

/**
 * The selection's handles for the keyboard and assistive technology (FLR-T-18.16; the board's handle
 * rules on frame 18.4: "Tab moves between handles; arrows nudge the focused handle by the snap step,
 * ⇧ × 4; Enter types an exact size"). The handles on the plan are pictures the tool controller
 * hit-tests (furniture/Handles.tsx, rooms/RoomLayer.tsx); over each, here, is a focusable slider of
 * the handle's 24 px hit area, drawn in the plan's SVG, that lets the pointer through. Tab from the plan comes to the first;
 * → and ↑ move the focused handle out — the item or the room bigger by a snap step — ← and ↓ in,
 * ⇧ four steps; on the rotate handle they turn the item 15° (⇧ 1°). Each press is the op a drag
 * would send — one resizeElement, one resizeRoom, one turn — so each is one undo step. Enter on an
 * item's handle goes to its typed size in the inspector; Esc goes back to the plan. The new size is
 * the slider's value, and said in a polite live region.
 */

const f1 = (n: number) => n.toFixed(1);

/** What the handles last said, per editor: the live region (HTML) beside the handles (SVG). */
class Said {
  text = '';
  private readonly listeners = new Set<() => void>();
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  say(text: string): void {
    // A new string each time, so the same size said twice is said again.
    this.text = this.text === text ? `${text}\u00a0` : text;
    for (const l of this.listeners) l();
  }
}
const said = new WeakMap<EditorStore, Said>();
const saidOf = (store: EditorStore): Said => {
  let s = said.get(store);
  if (s === undefined) {
    s = new Said();
    said.set(store, s);
  }
  return s;
};

/** The handles' polite live region: the new size after each press. */
export function KeyHandlesLive({ store }: { store: EditorStore }) {
  const s = saidOf(store);
  const text = useSyncExternalStore(s.subscribe, () => s.text, () => s.text);
  return (
    <div className="fs-keyhandles__live" role="status" aria-live="polite">
      {text}
    </div>
  );
}
const SIDE_WORDS: Readonly<Record<HandleSide, string>> = {
  front: 'front edge',
  back: 'back edge',
  left: 'left side',
  right: 'right side',
  'front-left': 'front left corner',
  'front-right': 'front right corner',
  'back-left': 'back left corner',
  'back-right': 'back right corner',
};
const AXES_WORDS: Readonly<Record<HandleSide, string>> = {
  front: 'Depth',
  back: 'Depth',
  left: 'Width',
  right: 'Width',
  'front-left': 'Width and depth',
  'front-right': 'Width and depth',
  'back-left': 'Width and depth',
  'back-right': 'Width and depth',
};
const BIG = 1_280_000 * 100; // 100 m: a slider's top, as base units.

/** The selected item or room the handles are for, when there is exactly one and the select tool is in use. */
function useTarget(store: EditorStore, level: LevelView): { device: DeviceView } | { room: string } | null {
  const selection = useEditor(store, (s) => {
    const dragging = s.draft?.tool === 'select' && s.draft.drag !== null;
    return s.selected.length === 1 && s.tool === 'select' && s.readOnly === null && s.compare === null && !dragging ? s.selection : null;
  });
  if (selection === null) return null;
  const device = level.devices.find((d) => d.id === selection);
  if (device !== undefined) return isResizable(device) ? { device } : null;
  return level.rooms.some((r) => r.id === selection) ? { room: selection } : null;
}

export function KeyHandles({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const target = useTarget(store, level);
  const model = useEditor(store, (s) => s.model);
  const units = useEditor(store, () => store.units);
  if (target === null || model === null) return null;
  const say = (text: string) => {
    saidOf(store).say(text);
  };

  const common = (e: KeyboardEvent<SVGElement>): 1 | -1 | 'enter' | 'escape' | null => {
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') return 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') return -1;
    if (e.key === 'Enter') return 'enter';
    if (e.key === 'Escape') return 'escape';
    return null;
  };

  let handles: ReactNode[];
  if ('device' in target) {
    const d = target.device;
    const b = boxOf(d.element);
    if (b === null) return null;
    const size = sizeOf(b);
    const name = labelOf(model, d.id);
    const rule = ruleFor(d);
    handles = handlesOf(d).map((h) => {
      const p = toScreen(view, h.at);
      const axis = h.axes.length === 2 ? 'width' : (h.axes[0] ?? 'width');
      const onKey = (e: KeyboardEvent<SVGElement>) => {
        const k = common(e);
        if (k === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (k === 'escape') {
          focusCanvas();
          return;
        }
        if (k === 'enter') {
          typeSize(store, axis === 'width' ? 'Width' : 'Depth');
          return;
        }
        void pressResize(store, d.id, h.side, k, e.shiftKey).then(say);
      };
      return (
        <circle
          key={h.side}
          role="slider"
          tabIndex={0}
          data-key-handle={h.side}
          className="fs-keyhandle"
          cx={f1(p[0])}
          cy={f1(p[1])}
          r={12}
          aria-label={`${AXES_WORDS[h.side]}, ${SIDE_WORDS[h.side]} of ${name}`}
          aria-valuemin={rule.limits[axis]?.min ?? 32_512}
          aria-valuemax={rule.limits[axis]?.max ?? BIG}
          aria-valuenow={size[axis]}
          aria-valuetext={h.axes.length === 2 ? `${prettyLen(size.width, units)} × ${prettyLen(size.depth, units)}` : prettyLen(size[axis], units)}
          aria-keyshortcuts="ArrowRight ArrowLeft Shift+ArrowRight Shift+ArrowLeft Enter Escape"
          aria-roledescription="resize handle"
          onKeyDown={onKey}
        />
      );
    });
    const rot = rotateHandleOf(d, view.s);
    if (rot !== null) {
      const p = toScreen(view, rot);
      const now = typeof d.host?.['rotation'] === 'number' ? d.host['rotation'] : 0;
      // The slider's value: clockwise degrees from as drawn, so → (bigger) turns it right.
      const cw = -Math.round(now / 1_000_000);
      const turnText = cw === 0 ? 'as drawn' : `${String(Math.abs(cw))}° ${cw > 0 ? 'right' : 'left'}`;
      handles.push(
        <circle
          key="rotate"
          role="slider"
          tabIndex={0}
          data-key-handle="rotate"
          className="fs-keyhandle fs-keyhandle--rotate"
          cx={f1(p[0])}
          cy={f1(p[1])}
          r={12}
          aria-label={`Turn ${name}`}
          aria-valuemin={-179}
          aria-valuemax={180}
          aria-valuenow={cw === -180 ? 180 : cw}
          aria-valuetext={`Turned ${turnText}`}
          aria-roledescription="rotate handle"
          onKeyDown={(e) => {
            const k = common(e);
            if (k === null || k === 'enter') return;
            e.preventDefault();
            e.stopPropagation();
            if (k === 'escape') {
              focusCanvas();
              return;
            }
            void pressTurn(store, d.id, k, e.shiftKey).then((text) => {
              if (text !== null) say(text);
            });
          }}
        />,
      );
    }
  } else {
    const room = target.room;
    const name = labelOf(model, room);
    handles = roomSides(level, room)
      .filter((s) => s.ok)
      .map((s) => {
        const p = toScreen(view, s.at);
        const across = extentAcross(level, room, s.side);
        return (
          <circle
            key={s.side}
            role="slider"
            tabIndex={0}
            data-key-handle={s.side}
            className="fs-keyhandle"
            cx={f1(p[0])}
            cy={f1(p[1])}
            r={12}
            aria-label={`${capital(s.side)} side of ${name}`}
            aria-valuemin={minRoom(units)}
            aria-valuemax={BIG}
            aria-valuenow={Math.round(across)}
            aria-valuetext={`${prettyLen(Math.round(across), units)} ${s.side === 'east' || s.side === 'west' ? 'east to west' : 'north to south'}`}
            aria-roledescription="room edge handle"
            onKeyDown={(e) => {
              const k = common(e);
              if (k === null || k === 'enter') return;
              e.preventDefault();
              e.stopPropagation();
              if (k === 'escape') {
                focusCanvas();
                return;
              }
              void pressRoomSide(store, room, s.side, k, e.shiftKey).then(say);
            }}
          />
        );
      });
  }
  return (
    <g className="fs-keyhandles" data-testid="key-handles">
      {handles}
    </g>
  );
}

// ─── A press ─────────────────────────────────────────────────────────────────────────────────
//
// Each press is one apply on the store's queue, its batch built when its turn comes — from the model
// the press before it made, as the plan's nudges are (nudge.ts) — so presses quicker than the server
// land one after another, each from where the last left the item, and none is sent against a model
// that is about to change under it (FLR-T-18.19). Each says what it made, or why it made nothing.

const deviceIn = (store: EditorStore, id: string): DeviceView | undefined => store.levelView?.devices.find((d) => d.id === id);
const nameOf = (store: EditorStore, id: string): string => {
  const model = store.get().model;
  return model === null ? id : labelOf(model, id);
};
function sizeText(store: EditorStore, d: DeviceView | undefined): string {
  const b = d === undefined ? null : boxOf(d.element);
  if (b === null) return '';
  const s = sizeOf(b);
  return `${prettyLen(s.width, store.units)} wide × ${prettyLen(s.depth, store.units)} deep`;
}

/** An item's resize handle: a snap step out (`dir` 1) or in, ⇧ four. What to say once it has landed. */
export async function pressResize(store: EditorStore, id: string, side: HandleSide, dir: 1 | -1, coarse: boolean): Promise<string> {
  const name = nameOf(store, id);
  // What the batch, built later, found: written by the builder, read once the press has landed.
  const found: { limit: string | null } = { limit: null };
  const ok = await store.apply(`Resize ${name}`, () => {
    const now = deviceIn(store, id);
    if (now === undefined) return [];
    const next = keyResize(now, side, dir, coarse);
    if (next === null) {
      found.limit = `${name} is as ${dir > 0 ? 'large' : 'small'} as it goes that way: ${sizeText(store, now)}`;
      return [];
    }
    return resizeBatch(id, next.anchor, next.size, ruleFor(now));
  }, { select: () => id });
  return ok ? `${name}: ${sizeText(store, deviceIn(store, id))}` : (found.limit ?? refusal(store, `${name} was not resized`));
}

/** An item's rotate handle: 15° clockwise (`dir` 1) or back, ⇧ 1°. Null for an item that does not turn. */
export async function pressTurn(store: EditorStore, id: string, dir: 1 | -1, fine: boolean): Promise<string | null> {
  const name = nameOf(store, id);
  const found: { rotation: number | null } = { rotation: null };
  const ok = await store.apply(`Turn ${name}`, () => {
    const now = deviceIn(store, id);
    const rotation = now === undefined ? null : keyRotate(now, dir, fine);
    found.rotation = rotation;
    return now === undefined || rotation === null ? [] : turnBatch(now, rotation);
  }, { select: () => id });
  const rotation = found.rotation;
  if (rotation === null) return null;
  if (!ok) return refusal(store, `${name} was not turned`);
  const deg = -Math.round(rotation / 1_000_000);
  return `${name}: turned ${deg === 0 ? 'back as drawn' : `${String(Math.abs(deg))}° ${deg > 0 ? 'right' : 'left'}`}`;
}

/** A room's side: a grid step out (`dir` 1) or in, ⇧ four — one resizeRoom. */
export async function pressRoomSide(store: EditorStore, room: string, side: Side, dir: 1 | -1, coarse: boolean): Promise<string> {
  const name = nameOf(store, room);
  const step = gridStepOf(store) * (coarse ? 4 : 1);
  const found: { limit: string | null } = { limit: null };
  const ok = await store.apply(`Resize ${name} ${side} ${formatLen(step, store.units)} ${dir > 0 ? 'out' : 'in'}`, () => {
    const lv = store.levelView;
    if (lv === undefined) return [];
    if (dir < 0 && extentAcross(lv, room, side) - step < minRoom(store.units)) {
      found.limit = `${name} is as small as a handle makes a room across that way.`;
      return [];
    }
    return resizeRoom(room, side, dir * step);
  }, { select: () => room });
  const after = store.levelView;
  if (ok && after !== undefined) return `${name}: ${prettyLen(Math.round(extentAcross(after, room, side)), store.units)} ${axisWords(side)}`;
  return found.limit ?? refusal(store, `${name} was not resized`);
}

/**
 * Why a press made no change, for the live region: the store's notice (a stale head, nothing to do,
 * a failure) or the rejection's first finding — said, not swallowed (FLR-T-18.19).
 */
function refusal(store: EditorStore, what: string): string {
  const { notice, rejection } = store.get();
  const why = notice?.text ?? rejection?.diagnostics[0]?.message;
  return why === undefined ? `${what}.` : `${what}: ${why}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const axisWords = (side: Side) => (side === 'east' || side === 'west' ? 'east to west' : 'north to south');

/** Enter on an item's handle: its typed size in the inspector — the drawer brought out if it was put away. */
function typeSize(store: EditorStore, field: 'Width' | 'Depth'): void {
  drawersOf(store).reveal('right');
  let tries = 6;
  const focus = () => {
    const label = [...document.querySelectorAll<HTMLLabelElement>('[data-drawer="right"] section[aria-label="Size"] label')].find((l) => l.textContent.trim() === field);
    const input = label === undefined ? null : document.getElementById(label.htmlFor);
    if (input !== null && input.getClientRects().length > 0) {
      input.focus();
      if (input instanceof HTMLInputElement) input.select();
      if (document.activeElement === input) return;
    }
    if (tries-- > 0) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}

/** Tab on the plan with handles showing: to the first handle (⇧Tab: the last). True when it moved there. */
export function focusHandles(back: boolean): boolean {
  if (typeof document === 'undefined') return false;
  const all = [...document.querySelectorAll<HTMLElement>('[data-key-handle]')];
  const to = back ? all[all.length - 1] : all[0];
  if (to === undefined) return false;
  to.focus({ preventScroll: true });
  return document.activeElement === to;
}
