import './underlay.css';
import { useEffect, useId, useRef, useState, type SyntheticEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Input } from '@d3cloud/ui';
import type { LevelView, Point } from '../model';
import type { EditorStore, Layers, Viewport } from '../store';
import { toScreen, toWorld } from '../viewport';
import { parseLen, prettyLen, type UnitSystem } from '../units';
import { snapAt } from '../precision/state';
import { StairsLayer } from '../RoofStairLayer';
import { assetHref } from '../../materials/api';
import { applyMove, applyScale } from './actions';
import { screenMatrix } from './transform';
import { neighbourLevel, underlayOf, useUnderlay, type Interaction } from './state';

/**
 * Trace and reference on the plan canvas (FLR-T-18.12): the underlay image under the walls, the
 * reference level in its ghost colour over the plan, and — while the underlay's scale is being set
 * or it is being moved — the clicks that do it.
 */

const fixed = (n: number): string => n.toFixed(3);

/**
 * A level's underlay, drawn where its placement puts it: above the floors (so a coloured plan does
 * not hide it) and under the walls, furniture and everything else.
 */
export function UnderlayImage({ store, view, level }: { store: EditorStore; view: Viewport; level: string }) {
  const u = useUnderlay(store, (s) => s.levels[level]);
  if (u === undefined || u.state === 'off') return null;
  const m = screenMatrix(u, view);
  return (
    <g className="fs-underlay" data-state={u.state} aria-hidden="true">
      <image
        data-underlay={level}
        href={assetHref(store.projectId, u.sha256)}
        width={u.width}
        height={u.height}
        preserveAspectRatio="none"
        opacity={u.state === 'ghost' ? u.opacity * 0.45 : u.opacity}
        transform={`matrix(${m.map(fixed).join(' ')})`}
      />
    </g>
  );
}

/**
 * The level below or above, in the reference colour: its walls, openings and stairs, faint and
 * outlined, never picked (pointer-events: none) and never edited — the tools pick only from the
 * level being drawn. Its junctions and wall corners are snapped to (precision/state.ts `snapAt`).
 */
export function ReferenceLayer({ store, view, level, layers }: { store: EditorStore; view: Viewport; level: string; layers: Layers }) {
  const side = useUnderlay(store, (s) => s.reference);
  // Re-read with the model: a level added or moved changes which is next to this one.
  const ref = side === 'off' ? null : neighbourLevel(store, level, side);
  if (ref === null) return null;
  return (
    <g className="fs-reference" data-reference={side} data-level={ref.id} aria-hidden="true">
      <ReferencePlan view={view} level={ref} layers={layers} />
    </g>
  );
}

function ReferencePlan({ view, level, layers }: { view: Viewport; level: LevelView; layers: Layers }) {
  const pts = (ring: readonly Point[]) => ring.map((p) => toScreen(view, p).map((n) => n.toFixed(1)).join(',')).join(' ');
  return (
    <>
      <g className="fs-reference__walls">
        {level.walls.map((w) => <polygon key={w.id} points={pts(w.ring)} />)}
        {level.fills.map((f) => <polygon key={f.id} className="fs-reference__fill" points={pts(f.ring)} />)}
      </g>
      {layers.openings ? (
        <g className="fs-reference__openings">
          {level.openings.map((o) => {
            const a = toScreen(view, o.start);
            const b = toScreen(view, o.end);
            return <line key={o.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
          })}
        </g>
      ) : null}
      <g className="fs-reference__stairs">
        <StairsLayer view={view} level={level} />
      </g>
    </>
  );
}

// ─── Setting the scale and moving: two clicks each ──────────────────────────────────────────

/** Pixels within which a click snaps, as the drawing tools use with a mouse. */
const SNAP_PX = 10;

/**
 * While the underlay is being calibrated or moved, a transparent sheet over the plan takes the
 * clicks (the wheel still reaches the canvas, so the view can be zoomed in to click precisely).
 * Setting the scale clicks the drawing itself, so its points are not snapped; a move's second
 * click is snapped like any drawing tool's — to the model, the reference level and the grid —
 * so a corner of the drawing lands exactly on a corner of the house.
 */
export function UnderlayCapture({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const interaction = useUnderlay(store, (s) => s.interaction);
  if (interaction === null) return null;
  const u = underlayOf(store);
  const world = (e: ReactPointerEvent<SVGRectElement>): Point => {
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    return toWorld(view, [e.clientX - r.left, e.clientY - r.top]);
  };
  const snapped = (p: Point) => snapAt(store, level, p, { tol: SNAP_PX / view.s, faces: true });
  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    e.stopPropagation();
    const p = world(e);
    const now = u.get().interaction;
    if (now?.kind === 'calibrate' && now.points.length < 2) u.set({ interaction: { ...now, cursor: p } });
    else if (now?.kind === 'move') u.set({ interaction: { ...now, cursor: now.from === null ? null : snapped(p) } });
  };
  const onDown = (e: ReactPointerEvent<SVGRectElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const p = world(e);
    const now = u.get().interaction;
    if (now?.kind === 'calibrate') {
      if (now.points.length < 2) u.set({ interaction: { ...now, points: [...now.points, p], cursor: null } });
    } else if (now?.kind === 'move') {
      if (now.from === null) u.set({ interaction: { ...now, from: p, cursor: snapped(p) } });
      else applyMove(store, level.id, now.from, snapped(p).point);
    }
  };
  return (
    <g className="fs-underlay-capture">
      <InteractionMarks view={view} interaction={interaction} />
      <rect
        className="fs-underlay-capture__sheet"
        data-testid="underlay-capture"
        x={0}
        y={0}
        width={view.w}
        height={view.h}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={(e) => { e.stopPropagation(); }}
      />
    </g>
  );
}

function InteractionMarks({ view, interaction }: { view: Viewport; interaction: Interaction }) {
  const S = (p: Point) => toScreen(view, p);
  const mark = (p: Point, key: string) => {
    const q = S(p);
    return (
      <g key={key} className="fs-underlay-capture__mark">
        <circle cx={q[0]} cy={q[1]} r={6} />
        <line x1={q[0] - 10} y1={q[1]} x2={q[0] + 10} y2={q[1]} />
        <line x1={q[0]} y1={q[1] - 10} x2={q[0]} y2={q[1] + 10} />
      </g>
    );
  };
  if (interaction.kind === 'calibrate') {
    const [a, b] = interaction.points;
    const end = b ?? interaction.cursor;
    return (
      <g aria-hidden="true">
        {a !== undefined && end !== null ? <line className="fs-underlay-capture__span" x1={S(a)[0]} y1={S(a)[1]} x2={S(end)[0]} y2={S(end)[1]} /> : null}
        {interaction.points.map((p, i) => mark(p, String(i)))}
      </g>
    );
  }
  const { from, cursor } = interaction;
  return (
    <g aria-hidden="true">
      {from !== null && cursor !== null ? <line className="fs-underlay-capture__span" x1={S(from)[0]} y1={S(from)[1]} x2={S(cursor.point)[0]} y2={S(cursor.point)[1]} /> : null}
      {from !== null ? mark(from, 'from') : null}
      {cursor !== null ? mark(cursor.point, 'to') : null}
    </g>
  );
}

/** What to click next, in words: the prompt over the canvas while an underlay is being worked. */
export function promptOf(interaction: Interaction): string {
  if (interaction.kind === 'calibrate') {
    if (interaction.points.length === 0) return 'Set scale: click the start of a length you know on the drawing';
    if (interaction.points.length === 1) return 'Set scale: click the end of that length';
    return 'Set scale: type the length between the two points';
  }
  return interaction.from === null ? 'Move: click a point on the drawing' : 'Move: click where that point goes — it snaps to the plan';
}

/**
 * The HTML half: the prompt bar with Cancel, the snap's words by the pointer while moving, and —
 * once both points of a length are clicked — the field the length is typed into. Esc cancels.
 */
export function UnderlayHtml({ store, view, level, units }: { store: EditorStore; view: Viewport; level: LevelView; units: UnitSystem }) {
  const interaction = useUnderlay(store, (s) => s.interaction);
  const u = underlayOf(store);
  const active = interaction !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      u.begin(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); };
  }, [active, u]);
  if (interaction === null) return null;
  const label = interaction.kind === 'move' ? interaction.cursor?.label : undefined;
  const at = interaction.kind === 'move' && interaction.cursor !== null ? toScreen(view, interaction.cursor.point) : null;
  const [a, b] = interaction.kind === 'calibrate' ? interaction.points : [];
  return (
    <>
      <div className="fs-underlay-prompt" role="status">
        <span>{promptOf(interaction)}</span>
        <Button size="sm" variant="ghost" onClick={() => { u.begin(null); }}>
          Cancel
        </Button>
      </div>
      {label !== undefined && at !== null ? (
        <span className="fs-guidetag" style={{ left: at[0] + 12, top: at[1] + 12 }} aria-hidden="true">
          {label}
        </span>
      ) : null}
      {a !== undefined && b !== undefined ? <LengthForm store={store} view={view} level={level} a={a} b={b} units={units} /> : null}
    </>
  );
}

function LengthForm({ store, view, level, a, b, units }: { store: EditorStore; view: Viewport; level: LevelView; a: Point; b: Point; units: UnitSystem }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const current = useUnderlay(store, (s) => s.levels[level.id]);
  const q = toScreen(view, b);
  // On the canvas, beside the second point, kept inside it.
  const left = Math.min(Math.max(8, q[0] + 16), Math.max(8, view.w - 280));
  const top = Math.min(Math.max(8, q[1] + 16), Math.max(8, view.h - 150));
  const drawn = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = parseLen(text, units);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    const why = applyScale(store, level.id, a, b, parsed.value);
    setError(why);
  };
  return (
    <form className="fs-underlay-length" style={{ left, top }} onSubmit={submit} aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="fs-underlay-length__title">
        Set scale
      </p>
      <label className="fs-underlay-length__label" htmlFor={`${id}-len`}>
        Length between the points
      </label>
      <Input
        ref={input}
        id={`${id}-len`}
        size="sm"
        value={text}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        aria-invalid={error === null ? undefined : true}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
      />
      <p id={`${id}-hint`} className="fs-underlay-length__hint">
        {error ?? (current === undefined ? '' : `Now ${prettyLen(Math.round(drawn), units)} as drawn`)}
      </p>
      <div className="fs-underlay-length__actions">
        <Button size="sm" variant="ghost" type="button" onClick={() => { underlayOf(store).begin(null); }}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit">
          Set scale
        </Button>
      </div>
    </form>
  );
}
