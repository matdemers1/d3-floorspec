import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Diagnostic, FloorspecDocument } from '@floorspec/engine';
import { Minus, Plus, Scan, ArrowUp } from 'lucide-react';
import { IconButton } from '@d3cloud/ui';
import { useEditor, type EditorStore, type Layers, type Viewport } from './store';
import type { ToolController, PointerInfo } from './tools';
import type { LevelView, OpeningView, Point, Ring, WallView, EditorModel } from './model';
import { labelOf } from './model';
import { add, centroid, dist, inFace, leftNormal, scale, sub } from './geometry';
import { fit, gridSpacing, scaleBar, toScreen, zoomAt, zoomPercent } from './viewport';
import { formatArea, formatLen, prettyLen, type UnitSystem } from './units';
import { typeChoices } from './ops';
import { commandById } from './commands';
import { diffModels, type ModelDiff } from './diff';
import { reviewDiagnostics, reviewTarget } from './review';
import { DeviceGhost, DeviceOutline, SystemsLayer } from './systems/Symbols';
import { kindById } from './systems/catalog';
import { anchorOf, circuitsOf } from './systems/view';

/**
 * The plan canvas (FLR-T-3.3): the level as `@floorspec/engine` derived it — wall poché from the
 * outlines and junction fills, separators dashed, openings with door swings and window glazing,
 * rooms with their names and areas — drawn in SVG, in screen pixels, with every colour a design
 * token (canvas.css), so both themes work.
 *
 * Layers, bottom to top: grid, plan, findings, selection and hover, the ghost (a preview of what a
 * batch would make — the seam live changesets will draw into), and the tool's own overlay.
 */

const S = (v: Viewport, p: Point) => toScreen(v, p);
const pts = (v: Viewport, ring: Ring) => ring.map((p) => S(v, p).map((n) => n.toFixed(1)).join(',')).join(' ');
const pathOf = (v: Viewport, rings: readonly Ring[]) => rings.map((r) => `M${pts(v, r)}Z`).join('');

export function PlanCanvas({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  // While two versions are compared, the canvas shows the newer of them, read-only (FLR-T-3.6).
  const model = useEditor(store, (s) => (s.compare === null ? s.model : (s.compare.toModel ?? s.model)));
  const comparing = useEditor(store, (s) => s.compare !== null);
  const levelId = useEditor(store, (s) => s.level);
  const view = useEditor(store, (s) => s.view);
  const layers = useEditor(store, (s) => s.layers);
  const tool = useEditor(store, (s) => s.tool);
  const level = useMemo(() => model?.levels.find((l) => l.id === levelId), [model, levelId]);
  const units = useEditor(store, () => store.units);
  const [coarse, setCoarse] = useState(false);

  // Size: fit the level on first layout and whenever the level changes.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const current = store.get().view;
      const key = store.get().level ?? '';
      if (current === null || fitted.current !== key) {
        fitted.current = key;
        store.set({ view: fit(store.levelView?.bounds ?? null, width, height) });
      } else {
        store.set({ view: { ...current, w: width, h: height } });
      }
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [store]);
  useEffect(() => {
    const view = store.get().view;
    if (view !== null && fitted.current !== (levelId ?? '')) {
      fitted.current = levelId ?? '';
      store.set({ view: fit(store.levelView?.bounds ?? null, view.w, view.h) });
    }
  }, [levelId, store]);

  // A proposal drawn on a level main has nothing on yet — a layout candidate (FLR-T-4.3) — is
  // framed when it is first shown: the empty level gives the view nothing to fit.
  const reviewed = useEditor(store, (s) => reviewTarget(s.review, s.model));
  const reviewFitted = useRef<string | null>(null);
  const hasView = useEditor(store, (s) => s.view !== null);
  useEffect(() => {
    const s = store.get();
    if (reviewed === null || s.review === null || s.view === null || reviewFitted.current === s.review.id) return;
    reviewFitted.current = s.review.id;
    const proposed = reviewed.levels.find((l) => l.id === s.level)?.bounds ?? null;
    if (proposed !== null && (store.levelView?.bounds ?? null) === null) store.set({ view: fit(proposed, s.view.w, s.view.h) });
  }, [reviewed, hasView, store]);

  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => { setCoarse(query.matches); };
    update();
    query.addEventListener('change', update);
    return () => { query.removeEventListener('change', update); };
  }, []);

  // The wheel must not scroll the page: a native, non-passive listener.
  useEffect(() => {
    const el = svg.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      tools.wheel({ x: e.clientX - r.left, y: e.clientY - r.top, dx: e.deltaX, dy: e.deltaY * (e.deltaMode === 1 ? 20 : 1), zoom: e.ctrlKey || e.metaKey || mouseWheel });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); };
  }, [tools]);

  const info = (e: React.PointerEvent): PointerInfo => {
    const r = (svg.current as SVGSVGElement).getBoundingClientRect();
    return {
      id: e.pointerId,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      type: e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse',
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      detail: e.detail,
    };
  };

  const picking = useEditor(store, (s) => s.picking !== null);
  const selection = useEditor(store, (s) => s.selection);
  const cursor = picking ? 'copy' : tool === 'select' ? 'default' : 'crosshair';
  // The plan steps back while the systems are being worked on (the board's "23").
  const focusSystems = tool === 'device' || picking;

  return (
    <div className="fs-canvas" ref={host} data-tool={tool} data-systems={focusSystems ? 'focus' : undefined}>
      {view !== null ? (
        <svg
          ref={svg}
          className="fs-canvas__svg"
          width={view.w}
          height={view.h}
          style={{ cursor }}
          role="application"
          aria-label={level === undefined ? 'Plan canvas' : `Plan of ${level.name}`}
          aria-roledescription="plan canvas"
          onPointerDown={(e) => {
            try {
              (e.currentTarget).setPointerCapture(e.pointerId);
            } catch {
              // A pointer the browser no longer tracks cannot be captured; the gesture still works.
            }
            (host.current?.closest('.fs-editor') as HTMLElement | null)?.focus({ preventScroll: true });
            tools.down(info(e));
          }}
          onPointerMove={(e) => { tools.move(info(e)); }}
          onPointerUp={(e) => { tools.up(info(e)); }}
          onPointerCancel={(e) => { tools.cancel({ id: e.pointerId }); }}
          onPointerLeave={() => { tools.leave(); }}
          onContextMenu={(e) => { e.preventDefault(); }}
        >
          <Grid view={view} units={units} />
          {model !== null && level !== undefined ? (
            <>
              <Plan view={view} level={level} document={model.document} layers={layers} units={units} labels={false} />
              {layers.dimensions ? <Dimensions view={view} level={level} units={units} /> : null}
              <SystemsLayer view={view} level={level} document={model.document} derived={model.derived} layers={layers} selection={selection} />
              <DiffLayer store={store} view={view} levelId={level.id} />
              <Findings store={store} view={view} level={level} />
              {comparing ? null : <Selection store={store} view={view} level={level} coarse={coarse} />}
              {layers.rooms ? <RoomLabels view={view} level={level} document={model.document} units={units} /> : null}
              <Ghost store={store} view={view} levelId={level.id} layers={layers} units={units} />
              {comparing ? null : <ToolOverlay store={store} view={view} level={level} model={model} />}
            </>
          ) : null}
        </svg>
      ) : null}
      {view !== null && model !== null && level !== undefined && !comparing ? <HtmlOverlays store={store} view={view} level={level} model={model} units={units} /> : null}
      <DiffLegend store={store} />
      {layers.coreOnly ? (
        <div className="fs-core-note" role="status">
          Core-only view: each building-system element drawn as a reader without its extension draws it — its fallback box (Floorspec Core 12.6).
        </div>
      ) : null}
      {view !== null ? <CanvasChrome store={store} view={view} units={units} /> : null}
    </div>
  );
}

// ─── Grid ────────────────────────────────────────────────────────────────────────────────────

function Grid({ view, units }: { view: Viewport; units: UnitSystem }) {
  const { minor, every } = gridSpacing(view, units);
  const lines: ReactNode[] = [];
  const step = minor * view.s;
  if (step < 6) return null;
  const x0 = Math.floor((view.cx - view.w / 2 / view.s) / minor);
  const x1 = Math.ceil((view.cx + view.w / 2 / view.s) / minor);
  const y0 = Math.floor((view.cy - view.h / 2 / view.s) / minor);
  const y1 = Math.ceil((view.cy + view.h / 2 / view.s) / minor);
  for (let i = x0; i <= x1; i++) {
    const x = (i * minor - view.cx) * view.s + view.w / 2;
    lines.push(<line key={`x${String(i)}`} className={i % every === 0 ? 'fs-grid__major' : 'fs-grid__minor'} x1={x} y1={0} x2={x} y2={view.h} />);
  }
  for (let i = y0; i <= y1; i++) {
    const y = view.h / 2 - (i * minor - view.cy) * view.s;
    lines.push(<line key={`y${String(i)}`} className={i % every === 0 ? 'fs-grid__major' : 'fs-grid__minor'} x1={0} y1={y} x2={view.w} y2={y} />);
  }
  return <g className="fs-grid" aria-hidden="true">{lines}</g>;
}

// ─── The plan ────────────────────────────────────────────────────────────────────────────────

/** A wall's centre line is offset from its location line when it is not centred (Core 5.4). */
function centreShift(wall: WallView): Point {
  return scale(leftNormal(wall.a, wall.b), (wall.left - wall.right) / 2);
}

export function Plan({ view, level, document, layers, units, ghost = false, labels = true }: { view: Viewport; level: LevelView; document: FloorspecDocument; layers: Layers; units: UnitSystem; ghost?: boolean; labels?: boolean }) {
  const walls = new Map(level.walls.map((w) => [w.id, w]));
  return (
    <g className={ghost ? 'fs-plan2 fs-plan2--ghost' : 'fs-plan2'} aria-hidden="true">
      {layers.rooms ? (
        <g className="fs-plan2__rooms">
          {level.faces.map((f, i) => (
            <path key={f.room ?? `free-${String(i)}`} className={f.room === null ? 'fs-plan2__face--free' : undefined} d={pathOf(view, [f.outer, ...f.holes])} fillRule="evenodd" />
          ))}
        </g>
      ) : null}
      <g className="fs-plan2__separators">
        {level.separators.map((s) => {
          const a = S(view, s.a);
          const b = S(view, s.b);
          return <line key={s.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
        })}
      </g>
      {layers.walls ? (
        <g className="fs-plan2__walls">
          {level.walls.map((w) => <polygon key={w.id} points={pts(view, w.ring)} />)}
          {level.fills.map((f) => <polygon key={f.id} points={pts(view, f.ring)} />)}
        </g>
      ) : null}
      {layers.openings ? (
        <g className="fs-plan2__openings">
          {level.openings.map((o) => {
            const wall = walls.get(o.wall);
            return wall === undefined ? null : <OpeningShape key={o.id} view={view} opening={o} wall={wall} />;
          })}
        </g>
      ) : null}
      {layers.rooms && !ghost && labels ? <RoomLabels view={view} level={level} document={document} units={units} /> : null}
    </g>
  );
}

function OpeningShape({ view, opening, wall }: { view: Viewport; opening: OpeningView; wall: WallView }) {
  const shift = centreShift(wall);
  const s0 = add(opening.start, shift);
  const e0 = add(opening.end, shift);
  const n = leftNormal(wall.a, wall.b);
  const half = wall.thickness / 2;
  const over = 1 / view.s; // one pixel past each face, so the cut is clean
  const gap = [add(s0, scale(n, half + over)), add(e0, scale(n, half + over)), add(e0, scale(n, -half - over)), add(s0, scale(n, -half - over))];
  const parts: ReactNode[] = [<polygon key="gap" className="fs-plan2__gap" points={pts(view, gap)} />];
  if (opening.kind === 'window') {
    for (const k of [-half, 0, half]) {
      const a = S(view, add(s0, scale(n, k * 0.92)));
      const b = S(view, add(e0, scale(n, k * 0.92)));
      parts.push(<line key={`g${String(k)}`} className="fs-plan2__glass" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />);
    }
  } else if (opening.kind === 'door') {
    const side = opening.swing === 'left' ? n : scale(n, -1);
    const hingeAt = opening.hinge === 'start' ? s0 : e0;
    const otherAt = opening.hinge === 'start' ? e0 : s0;
    const width = dist(s0, e0);
    const h = add(hingeAt, scale(side, half));
    const o = add(otherAt, scale(side, half));
    const tip = add(h, scale(side, width));
    const [H, O, T] = [S(view, h), S(view, o), S(view, tip)];
    const r = width * view.s;
    const sweep = (T[0] - H[0]) * (O[1] - H[1]) - (T[1] - H[1]) * (O[0] - H[0]) > 0 ? 1 : 0;
    parts.push(<line key="leaf" className="fs-plan2__leaf" x1={H[0]} y1={H[1]} x2={T[0]} y2={T[1]} />);
    parts.push(<path key="swing" className="fs-plan2__swing" d={`M${T[0].toFixed(1)},${T[1].toFixed(1)}A${r.toFixed(1)},${r.toFixed(1)} 0 0 ${String(sweep)} ${O[0].toFixed(1)},${O[1].toFixed(1)}`} />);
  } else {
    for (const at of [s0, e0]) {
      const a = S(view, add(at, scale(n, half)));
      const b = S(view, add(at, scale(n, -half)));
      parts.push(<line key={`j${String(at[0])}`} className="fs-plan2__jamb" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />);
    }
  }
  return <g>{parts}</g>;
}

function RoomLabels({ view, level, document, units }: { view: Viewport; level: LevelView; document: FloorspecDocument; units: UnitSystem }) {
  return (
    <g className="fs-plan2__labels">
      {level.rooms.map((room) => {
        const xs = room.outer.map((p) => p[0]);
        const width = (Math.max(...xs) - Math.min(...xs)) * view.s;
        if (width < 36) return null;
        const c = centroid(room.outer);
        const at = inFace(c, room) ? c : room.anchor;
        const p = S(view, at);
        const source = document.rooms?.[room.id];
        const name = typeof source?.name === 'string' ? source.name : room.id;
        const small = width < 90;
        return (
          <text key={room.id} x={p[0]} y={p[1] - (small ? 0 : 6)} textAnchor="middle">
            <tspan className="fs-plan2__name">{name}</tspan>
            {small ? null : (
              <tspan className="fs-plan2__area" x={p[0]} dy="16">
                {formatArea(room.area2, units)}
              </tspan>
            )}
          </text>
        );
      })}
    </g>
  );
}

// ─── Dimensions ──────────────────────────────────────────────────────────────────────────────

/**
 * The exterior dimension strings the board draws: along the top, the distances between junctions
 * on the level's top line; down the left, between those on its left line; and the overall size.
 */
function Dimensions({ view, level, units }: { view: Viewport; level: LevelView; units: UnitSystem }) {
  if (level.junctions.length < 2) return null;
  const xs = level.junctions.map((j) => j.position[0]);
  const ys = level.junctions.map((j) => j.position[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX === minX || maxY === minY) return null;
  const outerTop = level.bounds?.maxY ?? maxY;
  const outerLeft = level.bounds?.minX ?? minX;
  const top = [...new Set(level.junctions.filter((j) => j.position[1] === maxY).map((j) => j.position[0]))].sort((a, b) => a - b);
  const left = [...new Set(level.junctions.filter((j) => j.position[0] === minX).map((j) => j.position[1]))].sort((a, b) => b - a);
  const yLine = S(view, [0, outerTop])[1] - 26;
  const xLine = S(view, [outerLeft, 0])[0] - 26;
  const parts: ReactNode[] = [];
  const chain = (values: number[], horizontal: boolean) => {
    if (values.length < 2) return;
    const first = values[0] as number;
    const last = values[values.length - 1] as number;
    const a = horizontal ? S(view, [first, 0])[0] : S(view, [0, first])[1];
    const b = horizontal ? S(view, [last, 0])[0] : S(view, [0, last])[1];
    parts.push(horizontal ? <line key="h" className="fs-dim__line" x1={a} y1={yLine} x2={b} y2={yLine} /> : <line key="v" className="fs-dim__line" x1={xLine} y1={a} x2={xLine} y2={b} />);
    values.forEach((v, i) => {
      const at = horizontal ? S(view, [v, 0])[0] : S(view, [0, v])[1];
      parts.push(horizontal ? <line key={`ht${String(i)}`} className="fs-dim__tick" x1={at} y1={yLine - 4} x2={at} y2={yLine + 4} /> : <line key={`vt${String(i)}`} className="fs-dim__tick" x1={xLine - 4} y1={at} x2={xLine + 4} y2={at} />);
      const next = values[i + 1];
      if (next === undefined) return;
      const nextAt = horizontal ? S(view, [next, 0])[0] : S(view, [0, next])[1];
      if (Math.abs(nextAt - at) < 34) return;
      const mid = (at + nextAt) / 2;
      const text = formatLen(Math.abs(next - v), units);
      parts.push(
        horizontal ? (
          <text key={`hl${String(i)}`} className="fs-dim__text" x={mid} y={yLine - 6} textAnchor="middle">{text}</text>
        ) : (
          <text key={`vl${String(i)}`} className="fs-dim__text" x={xLine - 6} y={mid} textAnchor="middle" transform={`rotate(-90 ${(xLine - 6).toFixed(1)} ${mid.toFixed(1)})`}>{text}</text>
        ),
      );
    });
  };
  chain(top, true);
  chain(left, false);
  const corner = S(view, [level.bounds?.maxX ?? maxX, level.bounds?.minY ?? minY]);
  parts.push(
    <text key="overall" className="fs-dim__overall" x={corner[0]} y={corner[1] + 22} textAnchor="end">
      {`${formatLen(maxX - minX, units)} × ${formatLen(maxY - minY, units)}`}
    </text>,
  );
  return <g className="fs-dim" aria-hidden="true">{parts}</g>;
}

// ─── Findings, selection, hover ──────────────────────────────────────────────────────────────

/** The outline of any element on the level, for highlighting it. */
export function Outline({ view, level, id, className, pad = 0 }: { view: Viewport; level: LevelView; id: string; className: string; pad?: number }) {
  const wall = level.walls.find((w) => w.id === id);
  if (wall !== undefined) return <polygon className={className} points={pts(view, wall.ring)} />;
  const room = level.faces.find((f) => f.room === id);
  if (room !== undefined) return <path className={className} d={pathOf(view, [room.outer, ...room.holes])} fillRule="evenodd" />;
  const opening = level.openings.find((o) => o.id === id);
  if (opening !== undefined) {
    const host = level.walls.find((w) => w.id === opening.wall);
    if (host === undefined) return null;
    const shift = centreShift(host);
    const n = leftNormal(host.a, host.b);
    const half = host.thickness / 2 + 2 / view.s;
    const s0 = add(opening.start, shift);
    const e0 = add(opening.end, shift);
    return <polygon className={className} points={pts(view, [add(s0, scale(n, half)), add(e0, scale(n, half)), add(e0, scale(n, -half)), add(s0, scale(n, -half))])} />;
  }
  const sep = level.separators.find((s) => s.id === id);
  if (sep !== undefined) {
    const a = S(view, sep.a);
    const b = S(view, sep.b);
    return <line className={`${className} fs-hl--line`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
  }
  const junction = level.junctions.find((j) => j.id === id);
  if (junction !== undefined) {
    const p = S(view, junction.position);
    return <circle className={className} cx={p[0]} cy={p[1]} r={8 + pad} />;
  }
  const device = level.devices.find((d) => d.id === id);
  if (device !== undefined) return <DeviceOutline view={view} d={device} className={`${className} fs-hl--ring`} />;
  return null;
}

function Findings({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const rejection = useEditor(store, (s) => s.rejection);
  const preview = useEditor(store, (s) => s.preview);
  const layers = useEditor(store, (s) => s.layers);
  const review = useEditor(store, (s) => (s.side === 'review' ? s.review : null));
  const main = useEditor(store, (s) => s.model);
  const failed = reviewDiagnostics(review, main);
  const diagnostics: Diagnostic[] = rejection?.diagnostics ?? preview?.diagnostics ?? (failed.length > 0 ? failed : []);
  if (diagnostics.length === 0 || !layers.findings) return null;
  const ids = [...new Set(diagnostics.flatMap((d) => d.elements))];
  const points = diagnostics.flatMap((d) => (d.location.point !== undefined && (d.location.level === undefined || d.location.level === level.id) ? [d.location.point as Point] : []));
  return (
    <g className="fs-findings" aria-hidden="true">
      {ids.map((id) => <Outline key={id} view={view} level={level} id={id} className="fs-hl fs-hl--danger" />)}
      {points.map((p, i) => {
        const q = S(view, p);
        return <circle key={`p${String(i)}`} className="fs-hl fs-hl--danger" cx={q[0]} cy={q[1]} r={10} />;
      })}
    </g>
  );
}

function Selection({ store, view, level, coarse }: { store: EditorStore; view: Viewport; level: LevelView; coarse: boolean }) {
  const selection = useEditor(store, (s) => s.selection);
  const hover = useEditor(store, (s) => s.hover);
  const tool = useEditor(store, (s) => s.tool);
  const wall = selection === null ? undefined : (level.walls.find((w) => w.id === selection) ?? level.separators.find((sp) => sp.id === selection));
  const handles: Point[] = wall === undefined ? [] : [wall.a, wall.b];
  const junction = level.junctions.find((j) => j.id === selection);
  if (junction !== undefined) handles.push(junction.position);
  const size = coarse ? 14 : 5;
  return (
    <g className="fs-selection" aria-hidden="true">
      {hover !== null && hover !== selection && tool === 'select' ? <Outline view={view} level={level} id={hover} className="fs-hl fs-hl--hover" /> : null}
      {selection !== null ? <Outline view={view} level={level} id={selection} className="fs-hl fs-hl--selected" /> : null}
      {handles.map((h, i) => {
        const p = S(view, h);
        return coarse ? (
          <circle key={i} className="fs-handle" cx={p[0]} cy={p[1]} r={size} />
        ) : (
          <rect key={i} className="fs-handle" x={p[0] - size} y={p[1] - size} width={size * 2} height={size * 2} />
        );
      })}
    </g>
  );
}

/** The ghost layer: a batch's result, applied locally for preview, drawn over the plan. */
function Ghost({ store, view, levelId, layers, units }: { store: EditorStore; view: Viewport; levelId: string; layers: Layers; units: UnitSystem }) {
  const preview = useEditor(store, (s) => s.preview);
  const level = preview?.model?.levels.find((l) => l.id === levelId);
  if (preview?.model === null || preview?.model === undefined || level === undefined) return null;
  return <Plan view={view} level={level} document={preview.model.document} layers={{ ...layers, rooms: false }} units={units} ghost />;
}

// ─── Diffs: a proposal over main, or two versions compared ──────────────────────────────────

/** The two versions the canvas is diffing, and how to colour them. */
export function useDiff(store: EditorStore): { from: EditorModel; to: EditorModel; diff: ModelDiff; mode: 'proposal' | 'compare' } | null {
  const compare = useEditor(store, (s) => s.compare);
  const review = useEditor(store, (s) => (s.side === 'review' ? s.review : null));
  const main = useEditor(store, (s) => s.model);
  const units = useEditor(store, () => store.units);
  const target = reviewTarget(review, main);
  return useMemo(() => {
    if (compare !== null) {
      if (compare.fromModel === null || compare.toModel === null) return null;
      return { from: compare.fromModel, to: compare.toModel, diff: diffModels(compare.fromModel, compare.toModel, units), mode: 'compare' as const };
    }
    if (target === null || main === null) return null;
    return { from: main, to: target, diff: diffModels(main, target, units), mode: 'proposal' as const };
  }, [compare, target, main, units]);
}

/**
 * Added in accent (a proposal) or green (a comparison), removed dashed red, moved drawn twice —
 * where it was, ghosted, and where it is. A proposal is drawn over main, which stays the plan
 * underneath; a comparison draws the newer version as the plan.
 */
function DiffLayer({ store, view, levelId }: { store: EditorStore; view: Viewport; levelId: string }) {
  const d = useDiff(store);
  if (d === null) return null;
  const a = d.from.levels.find((l) => l.id === levelId);
  const b = d.to.levels.find((l) => l.id === levelId);
  const listed = new Set(d.diff.changes.map((c) => c.id));
  // Junctions that moved with their walls are carried by the walls' outlines.
  const shown = (id: string) => listed.has(id) || (d.to.index.get(id) ?? d.from.index.get(id)) !== 'junctions';
  const tone = d.mode === 'proposal' ? 'proposed' : 'added';
  const parts: ReactNode[] = [];
  for (const id of d.diff.ids.removed) if (a !== undefined && shown(id)) parts.push(<Outline key={`r-${id}`} view={view} level={a} id={id} className="fs-diff fs-diff--removed" />);
  for (const id of d.diff.ids.moved) {
    if (!shown(id)) continue;
    if (a !== undefined) parts.push(<Outline key={`w-${id}`} view={view} level={a} id={id} className="fs-diff fs-diff--was" />);
    if (b !== undefined) parts.push(<Outline key={`m-${id}`} view={view} level={b} id={id} className={d.mode === 'proposal' ? 'fs-diff fs-diff--proposed' : 'fs-diff fs-diff--moved'} />);
  }
  for (const id of d.diff.ids.added) if (b !== undefined && shown(id)) parts.push(<Outline key={`a-${id}`} view={view} level={b} id={id} className={`fs-diff fs-diff--${tone}`} />);
  for (const id of d.diff.ids.changed) if (b !== undefined && listed.has(id)) parts.push(<Outline key={`c-${id}`} view={view} level={b} id={id} className="fs-diff fs-diff--changed" />);
  return (
    <g className="fs-diffs" aria-hidden="true">
      {parts}
    </g>
  );
}

function DiffLegend({ store }: { store: EditorStore }) {
  const d = useDiff(store);
  if (d === null) return null;
  const c = d.diff.counts;
  const items: [string, string][] =
    d.mode === 'proposal'
      ? [['proposed', 'Proposed'], ['removed', 'Removed'], ['was', 'Was']]
      : [['added', `Added ${String(c.added)}`], ['removed', `Removed ${String(c.removed)}`], ['moved', `Moved ${String(c.moved)}`], ['was', 'Was']];
  return (
    <div className="fs-legend" role="note" aria-label="Legend">
      {items.map(([k, label]) => (
        <span key={k} className="fs-legend__item">
          <span className={`fs-legend__dot fs-legend__dot--${k}`} aria-hidden="true" />
          {label}
        </span>
      ))}
      {d.diff.same ? <span className="fs-legend__item">The same version</span> : null}
    </div>
  );
}

// ─── The tool's overlay ──────────────────────────────────────────────────────────────────────

function ToolOverlay({ store, view, level, model }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel }) {
  const draft = useEditor(store, (s) => s.draft);
  const draw = useEditor(store, (s) => s.draw);
  if (draft === null) return null;
  if (draft.tool === 'wall' || draft.tool === 'separator') {
    const chain = draft.chain.map((v) => v.point);
    const cursor = draft.cursor;
    const all = cursor !== null && chain.length > 0 ? [...chain, cursor.point] : chain;
    const type = draft.tool === 'wall' ? store.chosenType(typeChoices(model.document, 'wallType'), draw.wallType) : undefined;
    const layers = (type?.element['layers'] as { thickness: number }[] | undefined) ?? [];
    const thick = Math.max(3, layers.reduce((s, l) => s + l.thickness, 0) * view.s);
    const screen = all.map((p) => S(view, p));
    return (
      <g className="fs-draw" aria-hidden="true">
        {cursor?.guides.map(([a, b], i) => {
          const A = S(view, a);
          const B = S(view, b);
          return <line key={`g${String(i)}`} className="fs-draw__guide" x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />;
        })}
        {screen.length > 1 ? (
          <polyline className={draft.tool === 'wall' ? 'fs-draw__band' : 'fs-draw__sep'} points={screen.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')} strokeWidth={draft.tool === 'wall' ? thick : undefined} />
        ) : null}
        {screen.length > 1 ? <polyline className="fs-draw__line" points={screen.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')} /> : null}
        {chain.map((p, i) => {
          const q = S(view, p);
          return <rect key={i} className="fs-draw__vertex" x={q[0] - 5} y={q[1] - 5} width={10} height={10} />;
        })}
        {cursor !== null ? <SnapMarker view={view} snap={cursor} /> : null}
      </g>
    );
  }
  if (draft.tool === 'door' || draft.tool === 'window') {
    const hover = draft.hover;
    const wall = hover === null ? undefined : level.walls.find((w) => w.id === hover.wall);
    if (hover === null || wall === undefined) return null;
    const d = sub(wall.b, wall.a);
    const l = Math.hypot(d[0], d[1]) || 1;
    const u: Point = [d[0] / l, d[1] / l];
    const shift = centreShift(wall);
    const n = leftNormal(wall.a, wall.b);
    const half = wall.thickness / 2 + 2 / view.s;
    const s0 = add(add(wall.a, scale(u, hover.offset)), shift);
    const e0 = add(add(wall.a, scale(u, hover.offset + hover.width)), shift);
    return (
      <g className="fs-draw" aria-hidden="true">
        <polygon className="fs-hl fs-hl--hover" points={pts(view, wall.ring)} />
        <polygon className={hover.fits ? 'fs-draw__opening' : 'fs-draw__opening fs-draw__opening--bad'} points={pts(view, [add(s0, scale(n, half)), add(e0, scale(n, half)), add(e0, scale(n, -half)), add(s0, scale(n, -half))])} />
      </g>
    );
  }
  if (draft.tool === 'device') {
    const kind = kindById(draw.device);
    if (draft.hover === null || kind === undefined) return null;
    return (
      <g className="fs-draw" aria-hidden="true">
        {draft.hover.host.mode === 'wallFace' ? <polygon className="fs-hl fs-hl--hover" points={pts(view, level.walls.find((w) => w.id === (draft.hover?.host as { wall: string }).wall)?.ring ?? [])} /> : null}
        <DeviceGhost view={view} level={level.id} hover={draft.hover} kind={kind} receptacle={draw.receptacle} />
      </g>
    );
  }
  if (draft.tool === 'room') {
    const hover = draft.hover;
    if (hover === null) return null;
    const p = S(view, hover.point);
    return (
      <g className="fs-draw" aria-hidden="true">
        <path className={hover.free ? 'fs-draw__anchor' : 'fs-draw__anchor fs-draw__anchor--bad'} d={`M${String(p[0])},${String(p[1] - 8)}l8,8l-8,8l-8,-8z`} />
      </g>
    );
  }
  // Select: a dragged device, where it would go.
  if ('drag' in draft && draft.drag?.kind === 'device') {
    const device = level.devices.find((d) => d.id === (draft.drag as { id: string }).id);
    if (device?.kind === null || device === undefined) return null;
    return (
      <g className="fs-draw" aria-hidden="true">
        <DeviceGhost view={view} level={level.id} hover={draft.drag.hover} kind={device.kind} receptacle={{ gfci: false, afci: false, usb: false, v240: false }} />
      </g>
    );
  }
  // Select: a dragged junction's snap guides.
  if ('drag' in draft && draft.drag?.kind === 'junction') {
    return (
      <g className="fs-draw" aria-hidden="true">
        {draft.drag.snap.guides.map(([a, b], i) => {
          const A = S(view, a);
          const B = S(view, b);
          return <line key={i} className="fs-draw__guide" x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />;
        })}
        <SnapMarker view={view} snap={draft.drag.snap} />
      </g>
    );
  }
  return null;
}

function SnapMarker({ view, snap }: { view: Viewport; snap: { point: Point; kind: string } }) {
  const p = S(view, snap.point);
  if (snap.kind === 'junction') return <circle className="fs-draw__snap" cx={p[0]} cy={p[1]} r={7} />;
  if (snap.kind === 'wall') return <path className="fs-draw__snap" d={`M${String(p[0] - 7)},${String(p[1])}L${String(p[0])},${String(p[1] - 7)}L${String(p[0] + 7)},${String(p[1])}L${String(p[0])},${String(p[1] + 7)}Z`} />;
  return (
    <g className="fs-draw__cross">
      <line x1={p[0] - 8} y1={p[1]} x2={p[0] + 8} y2={p[1]} />
      <line x1={p[0]} y1={p[1] - 8} x2={p[0]} y2={p[1] + 8} />
    </g>
  );
}

// ─── HTML overlays: callouts, the length entry, the hover tooltip ────────────────────────────

function HtmlOverlays({ store, view, level, model, units }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; units: UnitSystem }) {
  const draft = useEditor(store, (s) => s.draft);
  const selection = useEditor(store, (s) => s.selection);
  const hover = useEditor(store, (s) => s.hover);
  const tool = useEditor(store, (s) => s.tool);
  const out: ReactNode[] = [];

  if ((draft?.tool === 'wall' || draft?.tool === 'separator') && draft.cursor !== null && draft.chain.length > 0) {
    const last = draft.chain[draft.chain.length - 1]?.point as Point;
    const to = draft.cursor.point;
    const mid = S(view, [(last[0] + to[0]) / 2, (last[1] + to[1]) / 2]);
    const length = Math.round(dist(last, to));
    if (length > 0 || draft.typed !== '') out.push(
      <div key="len" className="fs-entry" style={{ left: mid[0] + 14, top: mid[1] - 46 }} role="status" aria-live="polite">
        <span className="fs-entry__label">Length</span>
        <span className="fs-entry__value">{draft.typed !== '' ? draft.typed : formatLen(length, units)}</span>
        <span className="fs-entry__caret" />
        <span className="fs-entry__angle">→ {String(draft.cursor.angle ?? 0)}°</span>
      </div>,
    );
  }
  if ((draft?.tool === 'wall' || draft?.tool === 'separator') && draft.chain.length === 0 && draft.typed !== '') {
    out.push(
      <div key="start" className="fs-entry fs-entry--start" role="status" aria-live="polite">
        <span className="fs-entry__label">Start at</span>
        <span className="fs-entry__value">{draft.typed}</span>
        <span className="fs-entry__caret" />
      </div>,
    );
  }
  if ((draft?.tool === 'door' || draft?.tool === 'window') && draft.hover !== null) {
    const wall = level.walls.find((w) => w.id === draft.hover?.wall);
    if (wall !== undefined) {
      const L = dist(wall.a, wall.b);
      const fromStart = draft.hover.offset;
      const fromEnd = Math.round(L - draft.hover.offset - draft.hover.width);
      const at = draft.hover.nearer === 'start' ? `${formatLen(fromStart, units)} from start` : `${formatLen(fromEnd, units)} from end`;
      const mid = S(view, [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]);
      out.push(
        <div key="op" className="fs-entry" style={{ left: mid[0] + 14, top: mid[1] - 46 }} role="status" aria-live="polite">
          <span className="fs-entry__label">{draft.typed !== '' ? `Offset from ${draft.hover.nearer}` : 'At'}</span>
          <span className="fs-entry__value">{draft.typed !== '' ? draft.typed : draft.hover.centered ? 'centered' : at}</span>
          {draft.typed !== '' ? <span className="fs-entry__caret" /> : null}
        </div>,
      );
    }
  }
  if (draft?.tool === 'device' && draft.hover !== null) {
    const hover = draft.hover;
    const p = S(view, hover.point);
    const where =
      hover.problem ??
      (hover.host.mode === 'wallFace'
        ? `${hover.host.wall} · ${formatLen(Number(hover.host.at), units)} from start · ${formatLen(Number(hover.host.height), units)} high`
        : hover.host.mode === 'surface'
          ? `${labelOf(model, hover.host.room)} · ${hover.host.surface}`
          : 'Free on the level');
    out.push(
      <div key="dev" className="fs-entry" style={{ left: Math.min(p[0] + 14, view.w - 360), top: p[1] - 46 }} role="status" aria-live="polite">
        <span className="fs-entry__label">{draft.typed !== '' ? `Offset from ${hover.nearer ?? 'start'}` : 'At'}</span>
        <span className="fs-entry__value">{draft.typed !== '' ? draft.typed : where}</span>
        {draft.typed !== '' ? <span className="fs-entry__caret" /> : null}
      </div>,
    );
  }
  if (draft?.tool === 'select' && draft.drag?.kind === 'wall') {
    const wall = level.walls.find((w) => w.id === draft.drag?.id);
    if (wall !== undefined) {
      const mid = S(view, [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]);
      out.push(
        <div key="mv" className="fs-entry" style={{ left: mid[0] + 14, top: mid[1] - 46 }} role="status" aria-live="polite">
          <span className="fs-entry__label">Move</span>
          <span className="fs-entry__value">{draft.typed !== '' ? draft.typed : formatLen(Math.abs(draft.drag.by), units)}</span>
          <span className="fs-entry__angle">{draft.drag.by >= 0 ? 'exterior side' : 'interior side'}</span>
        </div>,
      );
    }
  }

  // The selected wall's length, beside it.
  const wall = selection === null || draft !== null ? undefined : level.walls.find((w) => w.id === selection);
  if (wall !== undefined) {
    const mid = S(view, [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2]);
    out.push(
      <div key="dim" className="fs-callout" style={{ left: mid[0] + 12, top: mid[1] - 12 }}>
        {prettyLen(Math.round(dist(wall.a, wall.b)), units)}
      </div>,
    );
  }
  if (hover !== null && hover !== selection && tool === 'select' && draft === null) {
    const anchor = hoverAnchor(level, hover);
    if (anchor !== null) {
      const p = S(view, anchor);
      out.push(
        <div key="tip" className="fs-tooltip" style={{ left: p[0] + 12, top: p[1] + 14 }}>
          {describeHover(model, level, hover, units)}
        </div>,
      );
    }
  }
  return <>{out}</>;
}

function hoverAnchor(level: LevelView, id: string): Point | null {
  const w = level.walls.find((x) => x.id === id) ?? level.separators.find((x) => x.id === id);
  if (w !== undefined) return [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
  const o = level.openings.find((x) => x.id === id);
  if (o !== undefined) return [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
  const j = level.junctions.find((x) => x.id === id);
  if (j !== undefined) return j.position;
  const d = level.devices.find((x) => x.id === id);
  if (d !== undefined) return anchorOf(d);
  return null;
}

function describeHover(model: EditorModel, level: LevelView, id: string, units: UnitSystem): string {
  const wall = level.walls.find((w) => w.id === id);
  if (wall !== undefined) {
    const type = wall.type === undefined ? undefined : model.document.types?.[wall.type];
    return [id, typeof type?.name === 'string' ? type.name : formatLen(wall.thickness, units), prettyLen(Math.round(dist(wall.a, wall.b)), units)].join(' · ');
  }
  const opening = level.openings.find((o) => o.id === id);
  if (opening !== undefined) return `${labelOf(model, id)} · ${prettyLen(opening.width, units)} wide`;
  const device = level.devices.find((d) => d.id === id);
  if (device !== undefined) {
    const circuits = circuitsOf(model.document, id);
    return [labelOf(model, id), device.kindLabel === labelOf(model, id) ? null : device.kindLabel, circuits.length > 0 ? `on ${circuits.join(', ')}` : null].filter((x) => x !== null).join(' · ');
  }
  return labelOf(model, id);
}

// ─── Chrome over the canvas: north, zoom, scale bar ──────────────────────────────────────────

function CanvasChrome({ store, view, units }: { store: EditorStore; view: Viewport; units: UnitSystem }) {
  const bar = scaleBar(view, units);
  const run = (id: string) => () => commandById(id)?.run(store, undefined as never);
  return (
    <>
      {/* An image with a name: aria-label on a plain div is not announced (ARIA 1.2 prohibits it). */}
      <div className="fs-north" role="img" aria-label="North is up">
        <ArrowUp aria-hidden="true" />
        <span aria-hidden="true">N</span>
      </div>
      <div className="fs-zoom">
        <IconButton size="sm" label="Zoom out" icon={<Minus />} onClick={run('view.zoomOut')} />
        <button type="button" className="fs-zoom__value" onClick={run('view.fit')} title="Zoom to fit">
          {zoomPercent(view)}%
        </button>
        <IconButton size="sm" label="Zoom in" icon={<Plus />} onClick={run('view.zoomIn')} />
        <IconButton size="sm" label="Zoom to fit" icon={<Scan />} onClick={run('view.fit')} />
      </div>
      <div className="fs-scalebar" aria-hidden="true">
        <span className="fs-scalebar__bar" style={{ width: bar.px }} />
        <span>{bar.label}</span>
      </div>
    </>
  );
}

export { zoomAt };
