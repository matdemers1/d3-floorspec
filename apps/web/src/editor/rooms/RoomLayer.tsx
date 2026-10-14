import './rooms.css';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Input, Select } from '@d3cloud/ui';
import { useEditor, type EditorStore, type Viewport, type WandDraft } from '../store';
import type { FaceView, LevelView, Point, Ring } from '../model';
import { boundsOf, centroid, faceAt } from '../geometry';
import { toScreen } from '../viewport';
import { prettyLen, type UnitSystem } from '../units';
import { ROOM_FUNCTIONS } from '../Inspector';
import type { ToolController } from '../tools';
import { extentAcross, roomFace, roomSides, type Side } from './edit';

/**
 * Rooms on the plan you can grab (FLR-T-18.10; the board's "Rooms get handles too" card on frame
 * 18.4). A selected room shows a pill on each side resizeRoom can move — the furniture's edge handle
 * (FLR-T-18.4), lying along the side — and while one is dragged, or the room is dragged by its floor,
 * the room it would be is drawn dashed over the plan with a dimension tag: "7′-6″ → 9′-0″". The walls
 * it would have are the ghost layer's, from the same previewed batch. The handles are pictures: the
 * tool controller hit-tests them (tools.ts), so they take no events.
 *
 * The magic wand draws the space under the pointer, then the space a click chose — the others it could
 * mean outlined, for Tab — and its prompt: the room's name and function, and the keys.
 */

const S = (v: Viewport, p: Point) => toScreen(v, p);
const f1 = (n: number) => n.toFixed(1);
const ringPath = (v: Viewport, rings: readonly Ring[]) => rings.map((r) => `M${r.map((p) => S(v, p).map(f1).join(',')).join(' ')}Z`).join('');

/** A selected room's edge handles: pills along the sides it can move. */
export function RoomHandles({ view, level, room, coarse }: { view: Viewport; level: LevelView; room: string; coarse: boolean }) {
  const sides = roomSides(level, room).filter((s) => s.ok);
  if (sides.length === 0) return null;
  const long = coarse ? 16 : 9;
  const short = coarse ? 6 : 3;
  return (
    <g className="fs-room-handles" aria-hidden="true" data-testid="room-handles">
      {sides.map((s) => {
        const p = S(view, s.at);
        const across = s.side === 'east' || s.side === 'west';
        const [hw, hh] = across ? [short, long] : [long, short];
        return (
          <rect
            key={s.side}
            className="fs-resize__handle fs-room-handle"
            data-testid={`room-handle-${s.side}`}
            data-side={s.side}
            x={f1(p[0] - hw)}
            y={f1(p[1] - hh)}
            width={hw * 2}
            height={hh * 2}
            rx={short}
          />
        );
      })}
    </g>
  );
}

/** A dimension tag on the plan, in screen space: the board's P18/Dimension tag. */
function Tag({ at, text, tone = 'dim', testId }: { at: Point; text: string; tone?: 'dim' | 'hint' | 'bad'; testId?: string }) {
  const w = Math.max(56, text.length * 6.8 + 16);
  return (
    <g className={`fs-room-tag fs-room-tag--${tone}`} transform={`translate(${f1(at[0])} ${f1(at[1])})`} data-testid={testId}>
      <rect x={f1(-w / 2)} y={-10} width={f1(w)} height={20} rx={4} />
      <text x={0} y={4} textAnchor="middle">{text}</text>
    </g>
  );
}

const WORD: Record<Side, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };

/** The room a drag would make: its outline from the previewed batch, dashed, and how big it would be. */
export function RoomDragGhost({ store, view, level, units }: { store: EditorStore; view: Viewport; level: LevelView; units: UnitSystem }) {
  const drag = useEditor(store, (s) => (s.draft?.tool === 'select' && (s.draft.drag?.kind === 'roomSide' || s.draft.drag?.kind === 'room') ? s.draft.drag : null));
  const preview = useEditor(store, (s) => s.preview);
  if (drag === null) return null;
  const now = roomFace(level, drag.id);
  if (now === undefined) return null;
  const next = preview?.model?.levels.find((l) => l.id === level.id);
  const after = next === undefined ? undefined : roomFace(next, drag.id);
  const shape = after ?? now;
  const c = S(view, centroid(shape.outer));
  const parts: ReactNode[] = [];
  if (after !== undefined) parts.push(<path key="ghost" className="fs-room__ghost" d={ringPath(view, [after.outer, ...after.holes])} fillRule="evenodd" />);
  let text: string;
  if (drag.kind === 'roomSide') {
    const was = extentAcross(level, drag.id, drag.side);
    text = `${prettyLen(Math.round(was), units)} → ${prettyLen(Math.round(was + drag.by), units)}`;
  } else {
    const [dx, dy] = drag.by;
    const bits = [dx !== 0 ? `${prettyLen(Math.abs(dx), units)} ${dx > 0 ? 'E' : 'W'}` : null, dy !== 0 ? `${prettyLen(Math.abs(dy), units)} ${dy > 0 ? 'N' : 'S'}` : null].filter((b) => b !== null);
    text = bits.length === 0 ? 'Move' : `Move ${bits.join(' · ')}`;
  }
  parts.push(<Tag key="dim" at={c} text={text} testId="room-dimension-tag" />);
  const problem = preview?.model === null ? preview.diagnostics[0]?.message : undefined;
  if (problem !== undefined) parts.push(<Tag key="bad" at={[c[0], c[1] + 26]} text={problem.length > 70 ? `${problem.slice(0, 69)}…` : problem} tone="bad" />);
  else if (drag.kind === 'roomSide') parts.push(<Tag key="hint" at={[c[0], c[1] + 26]} text={`${drag.side} side · walls follow · ⇧ free`} tone="hint" />);
  return (
    <g className="fs-room-drag" aria-hidden="true" data-testid="room-drag" data-kind={drag.kind} data-side={drag.kind === 'roomSide' ? WORD[drag.side] : undefined}>
      {parts}
    </g>
  );
}

/** The faces the wand would make a room of: the one under the pointer, or the chosen one and the others the click could mean. */
export function WandOverlay({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const draft = useEditor(store, (s) => (s.draft?.tool === 'wand' ? s.draft : null));
  if (draft === null) return null;
  if (draft.pick === null) {
    const face = draft.hover === null ? undefined : faceAt(level, draft.hover);
    if (face === undefined) return null;
    return (
      <g className="fs-wand-layer" aria-hidden="true">
        <path className={face.room === null ? 'fs-wand__face' : 'fs-wand__face fs-wand__face--taken'} d={ringPath(view, [face.outer, ...face.holes])} fillRule="evenodd" />
      </g>
    );
  }
  const faces = draft.pick.candidates.map((c) => faceAt(level, c.at));
  return (
    <g className="fs-wand-layer" aria-hidden="true" data-testid="wand-candidates" data-index={draft.pick.index} data-count={faces.length}>
      {faces.map((f, i) =>
        f === undefined || i === draft.pick?.index ? null : <path key={i} className="fs-wand__other" d={ringPath(view, [f.outer, ...f.holes])} fillRule="evenodd" />,
      )}
      {faces[draft.pick.index] === undefined ? null : <path className="fs-wand__chosen" data-testid="wand-chosen" d={ringPath(view, [(faces[draft.pick.index] as FaceView).outer, ...(faces[draft.pick.index] as FaceView).holes])} fillRule="evenodd" />}
    </g>
  );
}

type How = NonNullable<WandDraft['pick']>['candidates'][number]['how'];
const HOW: Record<How, string> = {
  here: 'the space clicked',
  around: 'the space around it',
  inside: 'a space inside it',
  beside: 'the space beside it',
};

/** The wand's prompt: the room's name and function, beside the space it will be made in. */
export function WandPrompt({ store, tools, view, level, units }: { store: EditorStore; tools: ToolController; view: Viewport; level: LevelView; units: UnitSystem }) {
  const pick = useEditor(store, (s) => (s.draft?.tool === 'wand' ? s.draft.pick : null));
  const input = useRef<HTMLInputElement>(null);
  const focusName = pick?.focusName === true;
  useEffect(() => {
    if (!focusName) return;
    const el = input.current;
    if (el !== null) {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
    tools.setWand({ focusName: false });
  }, [focusName, tools]);
  if (pick === null) return null;
  const chosen = pick.candidates[pick.index];
  const face = chosen === undefined ? undefined : faceAt(level, chosen.at);
  if (chosen === undefined || face === undefined) return null;
  const b = boundsOf(face.outer);
  const size = b === null ? '' : `${prettyLen(Math.round(b.maxX - b.minX), units)} × ${prettyLen(Math.round(b.maxY - b.minY), units)}`;
  // Beside the space, on its right, kept on the canvas.
  const right = b === null ? S(view, chosen.at) : S(view, [b.maxX, b.maxY]);
  const left = Math.max(8, Math.min(right[0] + 16, view.w - 296));
  const top = Math.max(8, Math.min(right[1], view.h - 236));
  const back = () => {
    document.querySelector<HTMLElement>('.fs-editor')?.focus({ preventScroll: true });
  };
  const n = pick.candidates.length;
  return (
    <div className="fs-wand" role="group" aria-label="Make a room" style={{ left, top }} data-testid="wand-prompt">
      <p className="fs-wand__status" role="status" aria-live="polite">
        <strong>{`Space ${String(pick.index + 1)} of ${String(n)}`}</strong> · {HOW[chosen.how]} · {size}
      </p>
      <label className="fs-wand__label" htmlFor="fs-wand-name">Name</label>
      <Input
        ref={input}
        id="fs-wand-name"
        appearance="filled"
        value={pick.name}
        maxLength={200}
        onChange={(e) => { tools.setWand({ name: e.target.value }); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            back();
            tools.commitWand();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            back();
            tools.escape();
          }
        }}
      />
      <span className="fs-wand__label" id="fs-wand-fn-label">Function</span>
      <Select
        aria-label="Function"
        appearance="filled"
        options={ROOM_FUNCTIONS.map(([value, label]) => ({ value, label }))}
        value={ROOM_FUNCTIONS.some(([v]) => v === pick.fn) ? pick.fn : 'unspecified'}
        onValueChange={(v) => { tools.setWand({ fn: v }); }}
      />
      <div className="fs-wand__actions">
        <Button size="sm" variant="primary" onClick={() => { back(); tools.commitWand(); }}>Make room</Button>
        {n > 1 ? <Button size="sm" variant="secondary" onClick={() => { tools.cycleWand(false); }}>Next space</Button> : null}
        <Button size="sm" variant="ghost" onClick={() => { back(); tools.escape(); }}>Cancel</Button>
      </div>
      <p className="fs-wand__keys" aria-hidden="true">
        <kbd>Tab</kbd> next space · <kbd>Enter</kbd> make it · <kbd>Esc</kbd> cancel
      </p>
    </div>
  );
}
