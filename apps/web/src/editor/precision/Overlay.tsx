import './precision.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@d3cloud/ui';
import { TriangleAlert } from 'lucide-react';
import { isArcDraft, isChainDraft, useEditor, type EditorStore, type Viewport } from '../store';
import type { EditorModel, LevelView, Point } from '../model';
import { labelOf } from '../model';
import { toScreen } from '../viewport';
import { formatArea, formatLen, parseLen, prettyLen, type UnitSystem } from '../units';
import type { Snap } from '../snap';
import { temporaryDimensions, type TempDim } from './dimensions';
import { summarize, triangleKind, WORK_TRIANGLE } from './measure';
import { DIM_REF_LABELS, DIM_REFS, precisionOf, usePrecision, type DimRef } from './state';

/**
 * What precision draws over the plan (FLR-T-18.9): the selection's temporary dimensions — a line and
 * a number that becomes a field when clicked — the distances ⌥ shows over an element, a drag's smart
 * guides and what they line up with, the snap's own words beside the pointer, and the measure tool's
 * tape and its panel. Lines are SVG in the canvas; numbers, fields and panels are HTML over it, so
 * they can be focused, typed into and read by a screen reader.
 */

const S = (v: Viewport, p: Point) => toScreen(v, p);

/** A dimension's ends, pushed off the element it belongs to by its shift (plan units plus pixels). */
function endsOf(view: Viewport, d: TempDim): { a: Point; b: Point } {
  if (d.shift === null) return { a: d.a, b: d.b };
  const k = d.shift.world + d.shift.px / view.s;
  const o: Point = [d.shift.dir[0] * k, d.shift.dir[1] * k];
  return { a: [d.a[0] + o[0], d.a[1] + o[1]], b: [d.b[0] + o[0], d.b[1] + o[1]] };
}

/** The selection's temporary dimensions, when they are shown: one element, the select tool, nothing being dragged. */
export function useTempDims(store: EditorStore, level: LevelView | undefined, model: EditorModel | null): { id: string; dims: TempDim[] } | null {
  const selection = useEditor(store, (s) => (s.selected.length === 1 ? s.selection : null));
  const quiet = useEditor(store, (s) => s.tool === 'select' && s.compare === null && (s.draft === null || (s.draft.tool === 'select' && s.draft.drag === null)));
  const ref = usePrecision(store, (p) => p.ref);
  return useMemo(() => {
    if (selection === null || !quiet || level === undefined || model === null) return null;
    const dims = temporaryDimensions(model, level, selection, ref);
    return dims.length === 0 ? null : { id: selection, dims };
  }, [selection, quiet, level, model, ref]);
}

/** What ⌥ held over an element shows: its distances to its neighbours, never editable. */
function useAltDims(store: EditorStore, level: LevelView, model: EditorModel): { id: string; dims: TempDim[] } | null {
  const alt = usePrecision(store, (p) => p.alt);
  const hover = useEditor(store, (s) => (s.tool === 'select' && (s.draft === null || (s.draft.tool === 'select' && s.draft.drag === null)) ? s.hover : null));
  return useMemo(() => {
    if (!alt || hover === null) return null;
    const dims = temporaryDimensions(model, level, hover, 'face');
    return dims.length === 0 ? null : { id: hover, dims };
  }, [alt, hover, level, model]);
}

function DimLine({ view, d, className }: { view: Viewport; d: TempDim; className: string }) {
  const { a, b } = endsOf(view, d);
  const A = S(view, a);
  const B = S(view, b);
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
  const n: Point = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
  const tick = (P: Point) => <line x1={P[0] - n[0] * 5} y1={P[1] - n[1] * 5} x2={P[0] + n[0] * 5} y2={P[1] + n[1] * 5} />;
  const ext = d.shift === null ? null : [S(view, d.a), S(view, d.b)];
  return (
    <g className={className} data-dim={d.key}>
      {ext !== null ? (
        <>
          <line className="fs-tempdim__ext" x1={ext[0]?.[0]} y1={ext[0]?.[1]} x2={A[0]} y2={A[1]} />
          <line className="fs-tempdim__ext" x1={ext[1]?.[0]} y1={ext[1]?.[1]} x2={B[0]} y2={B[1]} />
        </>
      ) : null}
      <line x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />
      {tick(A)}
      {tick(B)}
    </g>
  );
}

/** The SVG half: dimension lines, ⌥ distances, smart guides and the tape. */
export function PrecisionLayer({ store, view, level, model }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel }) {
  const temp = useTempDims(store, level, model);
  const alt = useAltDims(store, level, model);
  const editing = usePrecision(store, (p) => p.editing);
  const guides = usePrecision(store, (p) => p.guides);
  const tool = useEditor(store, (s) => s.tool);
  const measure = usePrecision(store, (p) => p.measure);
  const out: ReactNode[] = [];
  if (alt !== null) for (const d of alt.dims) out.push(<DimLine key={`alt-${d.key}`} view={view} d={d} className="fs-altdim" />);
  else if (temp !== null) for (const d of temp.dims) out.push(<DimLine key={`t-${d.key}`} view={view} d={d} className={d.key === editing ? 'fs-tempdim fs-tempdim--active' : 'fs-tempdim'} />);
  if (guides !== null)
    guides.lines.forEach(([a, b], i) => {
      const A = S(view, a);
      const B = S(view, b);
      out.push(<line key={`g${String(i)}`} className="fs-smartguide" x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />);
      out.push(<circle key={`gp${String(i)}`} className="fs-smartguide__dot" cx={A[0]} cy={A[1]} r={3} />);
    });
  if (tool === 'measure' && (measure.points.length > 0 || measure.cursor !== null)) {
    const pts = measure.points.map((m) => m.point);
    const open = !measure.closed && measure.done !== true;
    const all = open && measure.cursor !== null && pts.length > 0 ? [...pts, measure.cursor.point] : pts;
    const screen = all.map((p) => S(view, p));
    const str = screen.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
    out.push(
      <g key="measure" className="fs-measure" data-testid="measure-tape">
        {measure.closed ? <polygon className="fs-measure__area" points={str} /> : null}
        {screen.length > 1 ? (measure.closed ? <polygon className="fs-measure__tape" points={str} /> : <polyline className="fs-measure__tape" points={str} />) : null}
        {pts.map((p, i) => {
          const q = S(view, p);
          return <circle key={i} className="fs-measure__point" cx={q[0]} cy={q[1]} r={4.5} />;
        })}
        {open && measure.cursor !== null ? <MeasureCursor view={view} snap={measure.cursor} /> : null}
      </g>,
    );
  }
  return out.length === 0 ? null : <g className="fs-precision" aria-hidden="true">{out}</g>;
}

function MeasureCursor({ view, snap }: { view: Viewport; snap: Snap }) {
  const p = S(view, snap.point);
  return (
    <g className="fs-measure__cursor">
      {snap.guides.map(([a, b], i) => {
        const A = S(view, a);
        const B = S(view, b);
        return <line key={i} className="fs-smartguide" x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />;
      })}
      {snap.kind === 'grid' || snap.kind === 'free' || snap.kind === 'angle' ? (
        <>
          <line x1={p[0] - 7} y1={p[1]} x2={p[0] + 7} y2={p[1]} />
          <line x1={p[0]} y1={p[1] - 7} x2={p[0]} y2={p[1] + 7} />
        </>
      ) : (
        <circle cx={p[0]} cy={p[1]} r={6} />
      )}
    </g>
  );
}

// ─── The HTML half ───────────────────────────────────────────────────────────────────────────

export function PrecisionHtml({ store, view, level, model, units }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; units: UnitSystem }) {
  const temp = useTempDims(store, level, model);
  const alt = useAltDims(store, level, model);
  const editable = useEditor(store, (s) => s.readOnly === null && s.compare === null);
  const guides = usePrecision(store, (p) => p.guides);
  const tool = useEditor(store, (s) => s.tool);
  const out: ReactNode[] = [];
  if (alt !== null) {
    for (const d of alt.dims) {
      const { a, b } = endsOf(view, d);
      const m = S(view, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      out.push(
        <span key={`alt-${d.key}`} className="fs-altdim__value" style={{ left: m[0], top: m[1] }}>
          {prettyLen(Math.round(d.value), units)}
        </span>,
      );
    }
    out.push(
      <div key="alt-hint" className="fs-althint" role="status">
        <kbd>⌥</kbd> held over {labelOf(model, alt.id)} — distances to its neighbours
      </div>,
    );
  } else if (temp !== null) {
    out.push(<TempDims key={`dims-${temp.id}`} store={store} view={view} id={temp.id} dims={temp.dims} units={units} editable={editable} />);
  }
  if (guides?.label !== undefined && guides.at !== undefined) {
    const p = S(view, guides.at);
    out.push(
      <span key="guide" className="fs-guidetag" style={{ left: p[0] + 10, top: p[1] - 10 }}>
        {guides.label}
      </span>,
    );
  }
  out.push(<SnapTag key="snaptag" store={store} view={view} />);
  if (tool === 'measure') out.push(<MeasureHtml key="measure" store={store} view={view} model={model} level={level} units={units} />);
  return <>{out}</>;
}

/** The snap's words beside the pointer while drawing or measuring: "Midpoint of W3", "Parallel to W2". */
function SnapTag({ store, view }: { store: EditorStore; view: Viewport }) {
  const draftSnap = useEditor(store, (s): Snap | null => {
    const d = s.draft;
    if (isChainDraft(d) || isArcDraft(d)) return d.cursor;
    if (d?.tool === 'select' && d.drag?.kind === 'junction') return d.drag.snap;
    return null;
  });
  const measureSnap = usePrecision(store, (p) => (p.measure.closed || p.measure.done === true ? null : p.measure.cursor));
  const tool = useEditor(store, (s) => s.tool);
  const snap = tool === 'measure' ? measureSnap : draftSnap;
  if (snap?.label === undefined) return null;
  const p = S(view, snap.point);
  return (
    <span className="fs-guidetag" style={{ left: p[0] + 12, top: p[1] + 12 }}>
      {snap.label}
    </span>
  );
}

function TempDims({ store, view, id, dims, units, editable }: { store: EditorStore; view: Viewport; id: string; dims: TempDim[]; units: UnitSystem; editable: boolean }) {
  const editing = usePrecision(store, (p) => p.editing);
  const ref = usePrecision(store, (p) => p.ref);
  const p = precisionOf(store);
  return (
    <div className="fs-tempdims" role="group" aria-label={`Temporary dimensions of ${labelOf(store.get().model as EditorModel, id)}`}>
      {dims.map((d) => {
        const { a, b } = endsOf(view, d);
        const m = S(view, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        const text = prettyLen(Math.round(d.value), units);
        if (d.key === editing && editable && d.apply !== undefined) {
          return <DimField key={d.key} store={store} id={id} dim={d} units={units} at={m} refNow={ref} />;
        }
        return editable && d.apply !== undefined ? (
          <button
            key={d.key}
            type="button"
            className="fs-tempdim__value"
            data-dim={d.key}
            style={{ left: m[0], top: m[1] }}
            aria-label={`${d.label}: ${text} to ${d.to}. Type a new distance`}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={() => { p.set({ editing: d.key }); }}
          >
            {text}
          </button>
        ) : (
          <span key={d.key} className="fs-tempdim__value fs-tempdim__value--static" data-dim={d.key} style={{ left: m[0], top: m[1] }}>
            {text}
          </span>
        );
      })}
    </div>
  );
}

/**
 * A temporary dimension being typed into: Enter moves the element so it is that far (one batch, one
 * undo); Esc or leaving puts it back; Tab measures to the neighbour's face, centre line or other
 * face instead (⇧Tab the other way round), keeping the field open.
 */
function DimField({ store, id, dim, units, at, refNow }: { store: EditorStore; id: string; dim: TempDim; units: UnitSystem; at: Point; refNow: DimRef }) {
  const shown = formatLen(Math.round(dim.value), units);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const p = precisionOf(store);
  useEffect(() => {
    setText(shown);
    setError(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [shown, refNow]);
  const close = () => { p.set({ editing: null }); };
  const commit = () => {
    const parsed = parseLen(text, units);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    if (parsed.value < 0) {
      setError('A distance cannot be negative');
      return;
    }
    const r = dim.apply?.(parsed.value);
    if (r === undefined) return;
    if ('error' in r) {
      setError(r.error);
      return;
    }
    close();
    void store.apply(r.label, r.batch, { select: () => id });
  };
  return (
    <span className="fs-tempdim__edit" style={{ left: at[0], top: at[1] }}>
      <input
        ref={input}
        className="fs-tempdim__input"
        data-dim={dim.key}
        aria-label={`${dim.label}, to ${dim.to}`}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? `${dim.key}-err` : `${dim.key}-tab`}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onBlur={(e) => {
          // Leaving for the Tab hint keeps it open; anywhere else, nothing changes.
          if (e.relatedTarget instanceof HTMLElement && e.relatedTarget.closest('.fs-tempdim__edit') !== null) return;
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            p.cycleRef(e.shiftKey);
          }
        }}
      />
      <span id={`${dim.key}-tab`} className="fs-tempdim__tab">
        <kbd aria-hidden="true">⇥</kbd>
        <span className="fs-visually-hidden">Tab measures to: </span>
        {DIM_REFS.map((r, i) => (
          <span key={r} className={r === refNow ? 'fs-tempdim__ref fs-tempdim__ref--on' : 'fs-tempdim__ref'} aria-current={r === refNow ? 'true' : undefined}>
            {i > 0 ? <span aria-hidden="true"> → </span> : null}
            {DIM_REF_LABELS[r].toLowerCase()}
          </span>
        ))}
      </span>
      {error !== null ? (
        <span id={`${dim.key}-err`} className="fs-tempdim__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

// ─── The measure tool's labels and panel ─────────────────────────────────────────────────────

function MeasureHtml({ store, view, model, level, units }: { store: EditorStore; view: Viewport; model: EditorModel; level: LevelView; units: UnitSystem }) {
  const measure = usePrecision(store, (p) => p.measure);
  const p = precisionOf(store);
  const open = !measure.closed && measure.done !== true;
  const live = open && measure.cursor !== null && measure.points.length > 0 ? [...measure.points, { point: measure.cursor.point }] : measure.points;
  const summary = summarize({ points: live, closed: measure.closed }, (ref) => triangleKind(model, level, ref));
  const labels = summary.segments.map((s, i) => {
    const m = S(view, [(s.from.point[0] + s.to.point[0]) / 2, (s.from.point[1] + s.to.point[1]) / 2]);
    return (
      <span key={i} className="fs-measure__label" style={{ left: m[0], top: m[1] }}>
        {prettyLen(Math.round(s.length), units)}
      </span>
    );
  });
  const title = measure.closed ? 'area' : summary.segments.length > 1 ? 'chained' : 'point to point';
  const keep = p.keepAsDimension;
  return (
    <>
      {labels}
      <section className="fs-measurepanel" aria-label="Measurement" data-testid="measure-panel">
        <header className="fs-measurepanel__head">
          <span>Measure · {title}</span>
          <kbd>⇧M</kbd>
        </header>
        {summary.segments.length === 0 ? (
          <p className="fs-measurepanel__hint">Click a point to start; click on, chained; click the first point again for the area. Double-click or Enter ends it.</p>
        ) : (
          <dl className="fs-measurepanel__rows" aria-live="polite">
            {summary.segments.map((s, i) => (
              <div key={i} className="fs-measurepanel__row">
                <dt>{s.label}</dt>
                <dd>{prettyLen(Math.round(s.length), units)}</dd>
              </div>
            ))}
            {summary.segments.length > 1 ? (
              <div className="fs-measurepanel__row fs-measurepanel__row--total">
                <dt>Total</dt>
                <dd>{prettyLen(Math.round(summary.total), units)}</dd>
              </div>
            ) : null}
            {summary.area2 !== null ? (
              <div className="fs-measurepanel__row">
                <dt>Area enclosed</dt>
                <dd>{formatArea(summary.area2, units)}</dd>
              </div>
            ) : null}
          </dl>
        )}
        {summary.triangle !== null ? (
          <p className={summary.triangle.over ? 'fs-measurepanel__note fs-measurepanel__note--warn' : 'fs-measurepanel__note'}>
            {summary.triangle.over ? <TriangleAlert aria-hidden="true" /> : null}
            {summary.triangle.over ? `Over the ${prettyLen(WORK_TRIANGLE, units)} work-triangle guideline` : `Within the ${prettyLen(WORK_TRIANGLE, units)} work-triangle guideline`}
          </p>
        ) : null}
        <div className="fs-measurepanel__actions">
          {/* FLR-T-18.11 keeps a measurement as a dimension: it registers on the precision store. */}
          <Button
            size="sm"
            variant="secondary"
            disabled={keep === null || measure.points.length < 2 || open}
            title={keep === null ? 'Dimensions you keep arrive with FLR-T-18.11' : undefined}
            onClick={() => { keep?.(store, measure.points.map((m) => m.point)); }}
          >
            Keep as a dimension
          </Button>
          <Button size="sm" variant="ghost" disabled={measure.points.length === 0} onClick={() => { p.clearMeasure(); }}>
            Clear
          </Button>
        </div>
      </section>
    </>
  );
}
