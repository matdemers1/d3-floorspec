import type { ReactNode } from 'react';
import { roofSymbol, stairSymbol } from '@floorspec/render2d';
import type { Viewport } from './store';
import type { LevelView, Point, Ring } from './model';
import { toScreen } from './viewport';

/**
 * Roofs and stairs on the plan canvas (Core 0.3, chapters 16 and 17; FLR-T-7.2, 7.3). The symbols
 * are @floorspec/render2d's — the same treads, cut line, UP arrow, eave outline and ridge, hip and
 * valley lines the SVG plan draws — placed on the canvas's viewport. Nothing here derives geometry:
 * every point is one the engine derived.
 */

const S = (v: Viewport, p: Point): Point => toScreen(v, p);
const pts = (v: Viewport, ring: Ring): string => ring.map((p) => S(v, p).map((n) => n.toFixed(1)).join(',')).join(' ');

function Arrow({ view, points }: { view: Viewport; points: readonly Point[] }) {
  if (points.length < 2) return null;
  const screen = points.map((p) => S(view, p));
  const [x1, y1] = screen[screen.length - 1] ?? [0, 0];
  const [x0, y0] = screen[screen.length - 2] ?? [0, 0];
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const head = `${x1.toFixed(1)},${y1.toFixed(1)} ${(x1 - 8 * ux + 4 * uy).toFixed(1)},${(y1 - 8 * uy - 4 * ux).toFixed(1)} ${(x1 - 8 * ux - 4 * uy).toFixed(1)},${(y1 - 8 * uy + 4 * ux).toFixed(1)}`;
  return (
    <>
      <polyline className="fs-stair__arrow" points={screen.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')} />
      <polygon className="fs-stair__head" points={head} />
    </>
  );
}

/** Every stair rising from this level: treads (dashed above the cut plane), its landing, the break line and UP. */
export function StairsLayer({ view, level }: { view: Viewport; level: LevelView }) {
  if (level.stairs.length === 0) return null;
  return (
    <g className="fs-plan2__stairs">
      {level.stairs.map((st) => {
        const sym = stairSymbol(st.derived, st.form);
        const up = S(view, sym.up);
        return (
          <g key={st.id} data-stair={st.id}>
            {sym.steps.map((step, i) => (
              <polygon key={i} className={['fs-stair__step', step.landing ? 'fs-stair__step--landing' : '', step.above ? 'fs-stair__step--above' : ''].join(' ')} points={pts(view, step.outline)} />
            ))}
            {sym.bounds !== null ? <polygon className="fs-stair__bounds" points={pts(view, sym.bounds)} /> : null}
            {sym.circle !== null ? (
              <circle className="fs-stair__step" cx={S(view, sym.circle.centre)[0]} cy={S(view, sym.circle.centre)[1]} r={sym.circle.radius * view.s} />
            ) : null}
            {sym.cut !== null ? (
              <line className="fs-stair__cut" x1={S(view, sym.cut[0])[0]} y1={S(view, sym.cut[0])[1]} x2={S(view, sym.cut[1])[0]} y2={S(view, sym.cut[1])[1]} />
            ) : null}
            <Arrow view={view} points={sym.arrow} />
            <text className="fs-stair__up" x={up[0]} y={up[1] + 14} textAnchor="middle">
              UP
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** The roof layer: each roof's eave outline dashed, its ridges, hips and valleys, and its gable ends. */
export function RoofLayer({ view, level }: { view: Viewport; level: LevelView }) {
  if (level.roofs.length === 0) return null;
  return (
    <g className="fs-plan2__roofs">
      {level.roofs.map((rf) => {
        const sym = roofSymbol(rf.derived);
        return (
          <g key={rf.id} data-roof={rf.id} data-kind={rf.derived.kind}>
            <polygon className="fs-roof__eave" points={pts(view, sym.eave)} />
            {sym.lines.map((l, i) => {
              const a = S(view, l.from);
              const b = S(view, l.to);
              return <line key={i} className={`fs-roof__line fs-roof__line--${l.kind}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
            })}
            {sym.gables.map(([p, q], i) => {
              const a = S(view, p);
              const b = S(view, q);
              return <line key={`g${String(i)}`} className="fs-roof__gable" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
            })}
          </g>
        );
      })}
    </g>
  );
}

/** The highlight of a roof (its eave outline) or a stair (its box), for the selection and findings. */
export function roofStairOutline(view: Viewport, level: LevelView, id: string, className: string): ReactNode {
  const roof = level.roofs.find((r) => r.id === id);
  if (roof !== undefined) return <polygon className={className} points={pts(view, roof.derived.outline)} />;
  const stair = level.stairs.find((s) => s.id === id);
  if (stair !== undefined) {
    const { min, max } = stair.derived.box;
    return <polygon className={className} points={pts(view, [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]])} />;
  }
  return null;
}

/** The stair tool's draft: the foot, and the direction it will rise in towards the pointer. */
export function StairDraft({ view, foot, cursor }: { view: Viewport; foot: Point | null; cursor: Point | null }) {
  if (foot === null) {
    if (cursor === null) return null;
    const c = S(view, cursor);
    return (
      <g className="fs-draw" aria-hidden="true">
        <circle className="fs-draw__vertex" cx={c[0]} cy={c[1]} r={5} />
      </g>
    );
  }
  const a = S(view, foot);
  return (
    <g className="fs-draw" aria-hidden="true">
      {cursor !== null ? <Arrow view={view} points={[foot, cursor]} /> : null}
      <rect className="fs-draw__vertex" x={a[0] - 5} y={a[1] - 5} width={10} height={10} />
    </g>
  );
}
