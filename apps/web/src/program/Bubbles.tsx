import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor, type EditorStore } from '../editor/store';
import { bubbleAt, clamp, FRAME, layout, loadPositions, radii, R_NONE, savePositions, segment, type Vec } from './geometry';
import { DEFAULT_KIND, edgeLabel, edgeState, formatArea, KIND_LABEL, relate, relateRefusal, removeEdge, type ProgramView } from './model';

/** A label that fits across its bubble, cut short with an ellipsis when it does not. */
function fit(label: string, radius: number): string {
  const size = radius < 44 ? 13 : 16;
  const room = Math.max(4, Math.floor((radius * 1.8) / (size * 0.56)));
  return label.length <= room ? label : `${label.slice(0, room - 1).trimEnd()}…`;
}

/** What the inspector shows: a brief item, a line of the diagram, or nothing. */
export type Selection = { kind: 'item'; id: string } | { kind: 'edge'; key: string } | null;

interface Drag {
  id: string;
  pointer: number;
  /** Where the bubble was, and where the pointer took hold of it. */
  origin: Vec;
  grip: Vec;
  at: Vec;
  moved: boolean;
  /** The bubble the pointer is over: releasing there relates the two. */
  over: string | null;
}

/**
 * The bubble diagram (the board's "05", middle): one bubble per brief item, sized by its target
 * area; lines styled by kind — required solid in the accent, preferred dashed, forbidden dotted in
 * the danger colour with its marker — and a ring on any line the plan does not meet yet.
 *
 * Drag a bubble onto another to relate them (a `setAdjacency` of the default kind); drag it to
 * empty space to move it — where bubbles sit is this browser's view, not the model. Everything
 * has a key: Tab reaches each bubble and line, Enter selects, the arrows move a bubble, R starts
 * relating it to the next bubble chosen, Delete removes a line, Escape lets go.
 */
export function BubbleCanvas({
  store,
  view,
  selection,
  onSelect,
  relating,
  onRelating,
}: {
  store: EditorStore;
  view: ProgramView;
  selection: Selection;
  onSelect: (s: Selection) => void;
  relating: string | null;
  onRelating: (id: string | null) => void;
}) {
  const readOnly = useEditor(store, (s) => s.readOnly);
  const units = useEditor(store, () => store.units);
  const editable = readOnly === null && view.version === '0.2';
  // Before any room fulfils the brief, everything is unmet: the rings would only be noise.
  const judged = view.items.some((i) => i.rooms.length > 0);
  const [placed, setPlaced] = useState(() => loadPositions(store.projectId));
  const positions = useMemo(() => layout(view.items, view.edges, placed), [view.items, view.edges, placed]);
  const r = useMemo(() => radii(view.items), [view.items]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  // Once laid out, a bubble stays where it is: a new item does not move the others.
  useEffect(() => {
    if (view.items.every((i) => placed.has(i.id))) return;
    const next = new Map(positions);
    setPlaced(next);
    savePositions(store.projectId, next);
  }, [positions, placed, view.items, store.projectId]);

  const move = useCallback(
    (id: string, to: Vec) => {
      setPlaced((prev) => {
        const next = new Map(prev);
        next.set(id, clamp(to, r.get(id) ?? R_NONE));
        savePositions(store.projectId, next);
        return next;
      });
    },
    [r, store.projectId],
  );

  const relateTo = useCallback(
    (a: string, b: string) => {
      onRelating(null);
      if (!editable) return;
      const refused = relateRefusal(view, a, b, DEFAULT_KIND);
      const existing = view.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
      if (existing !== undefined) {
        // Already related: show that line, rather than add a second of another kind.
        onSelect({ kind: 'edge', key: existing.key });
        return;
      }
      if (refused !== null) {
        setRefusal(refused);
        return;
      }
      setRefusal(null);
      const label = `Relate ${view.items.find((i) => i.id === a)?.label ?? a} and ${view.items.find((i) => i.id === b)?.label ?? b}`;
      void store.apply(label, relate(a, b)).then((ok) => {
        if (ok) {
          const key = a < b ? `${a}|${b}|${DEFAULT_KIND}` : `${b}|${a}|${DEFAULT_KIND}`;
          onSelect({ kind: 'edge', key });
        }
      });
    },
    [editable, onRelating, onSelect, store, view],
  );

  const toWorld = (e: { clientX: number; clientY: number }): Vec => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (el === null || m === null || m === undefined) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  };

  const onBubbleDown = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    if (e.button !== 0) return;
    const p = toWorld(e);
    const at = positions.get(id) ?? p;
    (e.currentTarget.ownerSVGElement ?? e.currentTarget).setPointerCapture(e.pointerId);
    setDrag({ id, pointer: e.pointerId, origin: at, grip: [p[0] - at[0], p[1] - at[1]], at, moved: false, over: null });
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag === null || e.pointerId !== drag.pointer) return;
    const p = toWorld(e);
    const at: Vec = [p[0] - drag.grip[0], p[1] - drag.grip[1]];
    const moved = drag.moved || Math.hypot(at[0] - drag.origin[0], at[1] - drag.origin[1]) > 4;
    setDrag({ ...drag, at, moved, over: moved ? bubbleAt(p, positions, r, drag.id) : null });
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag === null || e.pointerId !== drag.pointer) return;
    setDrag(null);
    if (!drag.moved) {
      if (relating !== null && relating !== drag.id) relateTo(relating, drag.id);
      else onSelect({ kind: 'item', id: drag.id });
      return;
    }
    if (drag.over !== null) relateTo(drag.id, drag.over);
    else move(drag.id, drag.at);
  };

  const onBubbleKey = (e: ReactKeyboardEvent<SVGGElement>, id: string) => {
    const step = e.shiftKey ? 40 : 10;
    const arrows: Record<string, Vec> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const by = arrows[e.key];
    if (by !== undefined) {
      const at = positions.get(id);
      if (at !== undefined) move(id, [at[0] + by[0], at[1] + by[1]]);
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (relating !== null && relating !== id) relateTo(relating, id);
      else onSelect({ kind: 'item', id });
      return;
    }
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && editable) {
      e.preventDefault();
      setRefusal(null);
      onRelating(relating === id ? null : id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (relating !== null) onRelating(null);
      else onSelect(null);
    }
  };

  const onEdgeKey = (e: ReactKeyboardEvent<SVGGElement>, key: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect({ kind: 'edge', key });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editable) {
      e.preventDefault();
      const edge = view.edges.find((x) => x.key === key);
      if (edge !== undefined) void store.apply(`Remove the line ${edgeLabel(view, edge)}`, removeEdge(edge)).then((ok) => { if (ok) onSelect(null); });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onSelect(null);
    }
  };

  const shown = (id: string): Vec => (drag?.id === id && drag.moved && drag.over === null ? drag.at : (positions.get(id) ?? [FRAME.width / 2, FRAME.height / 2]));
  const relatingLabel = relating === null ? null : (view.items.find((i) => i.id === relating)?.label ?? relating);

  if (view.items.length === 0) {
    return (
      <div className="fs-bubbles fs-bubbles--empty">
        <p className="fs-bubbles__empty">Add brief items and they appear here as bubbles, sized by their target area. Drag one onto another to say they belong together.</p>
      </div>
    );
  }

  return (
    <div className="fs-bubbles">
      <div className="fs-bubbles__legend" role="note" aria-label="Legend">
        <span className="fs-legend__swatch fs-legend__swatch--required" aria-hidden="true" />
        <span>Required</span>
        <span className="fs-legend__swatch fs-legend__swatch--preferred" aria-hidden="true" />
        <span>Preferred</span>
        <span className="fs-legend__swatch fs-legend__swatch--forbidden" aria-hidden="true" />
        <span>Forbidden</span>
        <span className="fs-legend__ring" aria-hidden="true" />
        <span>Not met yet</span>
      </div>
      <svg
        ref={svg}
        className="fs-bubbles__svg"
        viewBox={`0 0 ${String(FRAME.width)} ${String(FRAME.height)}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Bubble diagram: ${String(view.items.length)} items, ${String(view.edges.length)} lines`}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { setDrag(null); }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            onRelating(null);
            onSelect(null);
          }
        }}
      >
        <g className="fs-bubbles__edges">
          {view.edges.map((edge) => {
            const pa = shown(edge.a);
            const pb = shown(edge.b);
            const seg = segment(pa, r.get(edge.a) ?? R_NONE, pb, r.get(edge.b) ?? R_NONE);
            if (seg === null) return null;
            const selected = selection?.kind === 'edge' && selection.key === edge.key;
            const label = `${edgeLabel(view, edge)}, ${KIND_LABEL[edge.kind].toLowerCase()}${edge.weight === 5 ? '' : `, weight ${String(edge.weight)}`}. ${edgeState(edge)}`;
            return (
              <g
                key={edge.key}
                className={`fs-edge fs-edge--${edge.kind}${selected ? ' is-selected' : ''}${judged && edge.met === false ? ' is-unmet' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected}
                onPointerDown={(e) => { e.stopPropagation(); }}
                onClick={() => { onSelect({ kind: 'edge', key: edge.key }); }}
                onKeyDown={(e) => { onEdgeKey(e, edge.key); }}
              >
                <line className="fs-edge__hit" x1={seg.from[0]} y1={seg.from[1]} x2={seg.to[0]} y2={seg.to[1]} />
                <line className="fs-edge__line" x1={seg.from[0]} y1={seg.from[1]} x2={seg.to[0]} y2={seg.to[1]} />
                {edge.kind === 'forbidden' ? <circle className="fs-edge__marker" cx={seg.mid[0]} cy={seg.mid[1]} r={7} /> : null}
                {judged && edge.met === false ? <circle className="fs-edge__unmet" cx={seg.mid[0]} cy={seg.mid[1]} r={12} /> : null}
              </g>
            );
          })}
          {drag?.moved === true && drag.over !== null ? (
            <line className="fs-edge__ghost" x1={drag.origin[0]} y1={drag.origin[1]} x2={shown(drag.over)[0]} y2={shown(drag.over)[1]} />
          ) : null}
        </g>
        <g className="fs-bubbles__rooms">
          {view.items.map((item) => {
            const [x, y] = shown(item.id);
            const radius = r.get(item.id) ?? R_NONE;
            const selected = selection?.kind === 'item' && selection.id === item.id;
            const classes = ['fs-bubble', selected ? 'is-selected' : '', judged && !item.need.met ? 'is-unmet' : '', relating === item.id ? 'is-relating' : '', drag?.over === item.id ? 'is-target' : '', drag?.id === item.id && drag.moved ? 'is-dragging' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <circle
                key={item.id}
                className={classes}
                cx={x}
                cy={y}
                r={radius}
              />
            );
          })}
        </g>
        <g className="fs-bubbles__labels">
          {view.items.map((item) => {
            const [x, y] = shown(item.id);
            const radius = r.get(item.id) ?? R_NONE;
            const selected = selection?.kind === 'item' && selection.id === item.id;
            const area = item.targetArea === undefined ? 'no target area' : formatArea(item.targetArea, units);
            const name = `${item.label}, ${item.function}, ${area}${item.count > 1 ? `, ${String(item.count)} rooms` : ''}. ${item.need.detail}`;
            return (
              <g
                key={item.id}
                className="fs-bubble__target"
                role="button"
                tabIndex={0}
                aria-label={relating !== null && relating !== item.id ? `Relate ${relatingLabel ?? ''} to ${name}` : name}
                aria-pressed={selected}
                onPointerDown={(e) => { e.stopPropagation(); onBubbleDown(e, item.id); }}
                onKeyDown={(e) => { onBubbleKey(e, item.id); }}
              >
                <circle className="fs-bubble__hit" cx={x} cy={y} r={radius} />
                <text x={x} y={y} textAnchor="middle" dominantBaseline="central" className="fs-bubble__name" style={{ fontSize: radius < 44 ? 13 : 16 }}>
                  {fit(item.label, radius)}
                </text>
                {item.count > 1 ? (
                  <text x={x} y={y + (radius < 44 ? 16 : 20)} textAnchor="middle" dominantBaseline="central" className="fs-bubble__count" style={{ fontSize: 13 }}>
                    ×{item.count}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="fs-bubbles__hint" role="status">
        {refusal !== null ? (
          <span className="fs-bubbles__refusal">{refusal}</span>
        ) : relating !== null ? (
          <span>
            Choose the bubble to relate <strong>{relatingLabel}</strong> to · <kbd>Esc</kbd> cancels
          </span>
        ) : (
          <span>Drag between bubbles to relate them · size follows target area · Tab, then R relates by keyboard</span>
        )}
      </div>
    </div>
  );
}
