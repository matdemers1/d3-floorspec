import type { LevelView, Point, Ring } from '../editor/model';
import './placing.css';
import type { EditorStore, Viewport } from '../editor/store';
import { useEditor } from '../editor/store';
import { toScreen } from '../editor/viewport';
import { add, scale, sub } from '../editor/geometry';
import { prettyLen, type UnitSystem } from '../editor/units';
import { DeviceGhost } from '../editor/systems/Symbols';
import { angleOf } from '../editor/systems/placement';
import type { DeviceView } from '../editor/systems/view';
import { symbolPlacement } from '../furniture/Plan';
import { entryOf, usePlacing } from './state';
import type { Entry } from './catalog';
import type { Ghost } from './ghost';

/**
 * The ghost on the plan (FLR-T-18.7, the board's "18.7 · Library drawer — dragging a sofa onto the
 * plan"): the item where it would go — its symbol over its footprint, a plant's canopy, a device's
 * symbol, an opening in its wall with a door's swing — its clearance envelopes, the guides it
 * snapped to, and over it in HTML the clear distances and a sentence saying where it is, with the
 * keys that turn it. Drawn in the warning tone where it runs into something. Every colour is a token.
 */

const f1 = (n: number) => n.toFixed(1);
const pts = (view: Viewport, ring: Ring) => ring.map((p) => toScreen(view, p).map(f1).join(',')).join(' ');

/** The ghost of what is being placed or dragged, or of the quick-add bar's highlighted entry. */
function useGhost(store: EditorStore): { ghost: Ghost; entry: Entry } | null {
  const ghost = usePlacing(store, (s) => s.ghost);
  const key = usePlacing(store, (s) => s.dragging?.key ?? s.active ?? s.quickKey);
  const entry = entryOf(store, key);
  if (ghost === null || entry === undefined) return null;
  return { ghost, entry };
}

function Body({ view, ghost, entry, level }: { view: Viewport; ghost: Ghost; entry: Entry; level: string }) {
  const src = entry.source;
  if (src.kind === 'device' && ghost.host !== null) {
    return <DeviceGhost view={view} level={level} hover={{ host: ghost.host, point: ghost.origin, facing: ghost.facing }} kind={src.device} receptacle={{ gfci: false, afci: false, usb: false, v240: false }} />;
  }
  if (src.kind === 'opening') {
    const aim = ghost.opening;
    if (aim === null || ghost.footprint.length === 0) return null;
    const [p0, p1, , p3] = ghost.footprint as [Point, Point, Point, Point];
    const along = sub(p1, p0);
    const t = scale(along, 1 / (Math.hypot(along[0], along[1]) || 1));
    // A door's swing: a quarter circle from its hinge, to the side it opens towards.
    const door = src.type.kind === 'doorType';
    const mid = (a: Point, b: Point): Point => scale(add(a, b), 0.5);
    const lineA = mid(p0, p3);
    const lineB = add(lineA, scale(t, aim.width));
    const hinge = aim.nearer === 'start' ? lineA : lineB;
    const free = aim.nearer === 'start' ? lineB : lineA;
    const n: Point = ghost.facing;
    const open = add(hinge, scale(n, aim.width));
    const [h, f, o] = [toScreen(view, hinge), toScreen(view, free), toScreen(view, open)];
    const r = Math.hypot(f[0] - h[0], f[1] - h[1]);
    const cross = (f[0] - h[0]) * (o[1] - h[1]) - (f[1] - h[1]) * (o[0] - h[0]);
    return (
      <>
        <polygon className="fs-ghost__opening" points={pts(view, ghost.footprint)} />
        {door ? (
          <>
            <line className="fs-ghost__leaf" x1={f1(h[0])} y1={f1(h[1])} x2={f1(o[0])} y2={f1(o[1])} />
            <path className="fs-ghost__swing" d={`M${f1(o[0])},${f1(o[1])} A${f1(r)},${f1(r)} 0 0 ${cross > 0 ? 0 : 1} ${f1(f[0])},${f1(f[1])}`} />
          </>
        ) : (
          <line className="fs-ghost__leaf" x1={f1(toScreen(view, lineA)[0])} y1={f1(toScreen(view, lineA)[1])} x2={f1(toScreen(view, lineB)[0])} y2={f1(toScreen(view, lineB)[1])} />
        )}
      </>
    );
  }
  if (src.kind === 'landscape' && src.collection === 'plants') {
    const c = toScreen(view, add(ghost.origin, [0, 0]));
    const r = ((entry.box.max[0] - entry.box.min[0]) / 2) * view.s;
    return (
      <>
        <circle className="fs-ghost__canopy" cx={f1(c[0])} cy={f1(c[1])} r={f1(r)} />
        <circle className="fs-ghost__trunk" cx={f1(c[0])} cy={f1(c[1])} r={f1(Math.min(3, r / 4))} />
      </>
    );
  }
  // Furniture, a bed: its footprint, and a library item's symbol over it (Core 12.6).
  const placed =
    entry.symbol === null
      ? null
      : symbolPlacement(view, { element: { fallback: { box: entry.box } }, placement: { point: ghost.origin, z: 0, facing: angleOf(ghost.facing) } } as unknown as DeviceView);
  return (
    <>
      <polygon className="fs-ghost__fill" points={pts(view, ghost.footprint)} />
      {placed !== null && entry.symbol !== null ? (
        <image className="fs-ghost__symbol" href={entry.symbol} x={0} y={0} width={f1(placed.width)} height={f1(placed.height)} preserveAspectRatio="none" transform={placed.transform} />
      ) : null}
    </>
  );
}

/** The ghost in the plan's <svg>: its envelopes, its body, its outline and its guides. */
export function PlacingLayer({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const shown = useGhost(store);
  if (shown === null) return null;
  const { ghost, entry } = shown;
  return (
    <g className="fs-ghost" data-testid="placing-ghost" data-blocked={ghost.blocked ? 'true' : undefined} data-entry={entry.key} aria-hidden="true">
      {ghost.envelopes.map((e) => (
        <polygon key={e.name} className="fs-ghost__envelope" points={pts(view, e.ring)} />
      ))}
      <Body view={view} ghost={ghost} entry={entry} level={level.id} />
      {ghost.footprint.length > 0 && entry.source.kind !== 'device' ? <polygon className="fs-ghost__outline" points={pts(view, ghost.footprint)} /> : null}
      {ghost.guides.map(([a, b], i) => {
        const [p, q] = [toScreen(view, a), toScreen(view, b)];
        return <line key={i} className="fs-ghost__guide" x1={f1(p[0])} y1={f1(p[1])} x2={f1(q[0])} y2={f1(q[1])} />;
      })}
      {ghost.gaps.map((g, i) => {
        const [p, q] = [toScreen(view, g.from), toScreen(view, g.to)];
        return <line key={`gap${String(i)}`} className="fs-ghost__gap" x1={f1(p[0])} y1={f1(p[1])} x2={f1(q[0])} y2={f1(q[1])} />;
      })}
    </g>
  );
}

/** Over the plan in HTML: each clear distance, and the sentence with the keys that turn it. */
export function PlacingLabels({ store, view, units }: { store: EditorStore; view: Viewport; units: UnitSystem }) {
  const shown = useGhost(store);
  const quick = usePlacing(store, (s) => s.quick !== null);
  const tool = useEditor(store, (s) => s.tool);
  if (shown === null) return null;
  const { ghost, entry } = shown;
  const ring = ghost.footprint.length > 0 ? ghost.footprint : [ghost.origin];
  const screen = ring.map((p) => toScreen(view, p));
  const top = Math.min(...screen.map((p) => p[1]));
  const cx = screen.reduce((s, p) => s + p[0], 0) / screen.length;
  const turns = entry.placement !== 'device' || (entry.source.kind === 'device' && entry.source.device.mount !== 'wall');
  return (
    <>
      {ghost.gaps.map((g, i) => {
        const m = toScreen(view, scale(add(g.from, g.to), 0.5));
        return (
          <span key={i} className="fs-ghost-gap" style={{ left: m[0], top: m[1] }} data-testid="placing-gap">
            {prettyLen(Math.round(g.length), units)}
          </span>
        );
      })}
      {quick && tool !== 'place' ? null : (
        <div className="fs-ghost-hint" role="status" style={{ left: cx, top: Math.max(8, top - 44) }} data-testid="placing-hint">
          <span className={ghost.blocked ? 'fs-ghost-hint__dot fs-ghost-hint__dot--blocked' : 'fs-ghost-hint__dot'} aria-hidden="true" />
          <span>{ghost.problem ?? ghost.label}</span>
          {turns ? (
            <>
              <kbd>R</kbd>
              <kbd>[</kbd>
              <kbd>]</kbd>
              <span className="fs-ghost-hint__faint">rotate</span>
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
