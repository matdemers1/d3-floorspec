import './resize.css';
import type { ReactNode } from 'react';
import type { LevelView, Point } from '../editor/model';
import type { Viewport } from '../editor/store';
import { toScreen } from '../editor/viewport';
import { prettyLen, type UnitSystem } from '../editor/units';
import type { DeviceView } from '../editor/systems/view';
import { boxOf, frameVectors, handlesOf, isResizable, rotateHandleOf, sizeOf, toPlan, type HandleSide } from './resize';

/**
 * The handles of a selected item on the plan (FLR-T-18.4, the board's frame 18.4): a square on each
 * edge and each corner of its footprint — an edge moves one side, a corner two — and, for an item
 * standing on a floor or free, a round rotate handle behind its back on a stem. While a handle is
 * dragged the footprint it would have is drawn over the plan, with its width and depth beside it.
 * The handles are pictures: the tool controller hit-tests them (tools.ts), so they take no events.
 */

const f1 = (n: number) => n.toFixed(1);

export function ResizeHandles({ view, device, coarse }: { view: Viewport; device: DeviceView; coarse: boolean }) {
  if (!isResizable(device)) return null;
  const size = coarse ? 8 : 4;
  const handles = handlesOf(device);
  const rotate = rotateHandleOf(device, view.s);
  const backMid = (() => {
    const b = boxOf(device.element);
    return b === null ? null : toPlan(frameVectors(device), b.min[0], (b.min[1] + b.max[1]) / 2);
  })();
  return (
    <g className="fs-resize" aria-hidden="true" data-testid="resize-handles">
      {rotate !== null && backMid !== null ? (
        <>
          <line className="fs-resize__stem" x1={f1(toScreen(view, backMid)[0])} y1={f1(toScreen(view, backMid)[1])} x2={f1(toScreen(view, rotate)[0])} y2={f1(toScreen(view, rotate)[1])} />
          <circle className="fs-resize__rotate" data-testid="rotate-handle" cx={f1(toScreen(view, rotate)[0])} cy={f1(toScreen(view, rotate)[1])} r={coarse ? 10 : 6} />
        </>
      ) : null}
      {handles.map((h) => {
        const p = toScreen(view, h.at);
        const edge = !h.side.includes('-');
        return (
          <rect
            key={h.side}
            className={edge ? 'fs-resize__handle fs-resize__handle--edge' : 'fs-resize__handle'}
            data-testid={`resize-handle-${h.side}`}
            x={f1(p[0] - size)}
            y={f1(p[1] - size)}
            width={size * 2}
            height={size * 2}
            rx={edge ? size : 1.5}
          />
        );
      })}
    </g>
  );
}

/** The footprint a drag would give an item, and its width and depth beside it. */
export function ResizeGhost({ view, device, units, label }: { view: Viewport; device: DeviceView; units: UnitSystem; label?: string | undefined }) {
  const b = boxOf(device.element);
  if (b === null) return null;
  const f = frameVectors(device);
  const corner = (x: number, y: number) => toScreen(view, toPlan(f, x, y));
  const [r0, r1, r2, r3] = [corner(b.min[0], b.min[1]), corner(b.max[0], b.min[1]), corner(b.max[0], b.max[1]), corner(b.min[0], b.max[1])];
  const ring = [r0, r1, r2, r3];
  const size = sizeOf(b);
  const tags: ReactNode[] = [];
  // Width along the item's right side, depth along its front: outside the footprint, in screen space.
  const tag = (key: string, a: Point, c: Point, out: Point, text: string) => {
    const m: Point = [(a[0] + c[0]) / 2 + out[0] * 18, (a[1] + c[1]) / 2 + out[1] * 18];
    tags.push(
      <g key={key} className="fs-resize__tag" transform={`translate(${f1(m[0])} ${f1(m[1])})`}>
        <rect x={-34} y={-10} width={68} height={20} rx={4} />
        <text x={0} y={4} textAnchor="middle">{text}</text>
      </g>,
    );
  };
  const centre: Point = [(r0[0] + r2[0]) / 2, (r0[1] + r2[1]) / 2];
  const outward = (a: Point, c: Point): Point => {
    const m: Point = [(a[0] + c[0]) / 2 - centre[0], (a[1] + c[1]) / 2 - centre[1]];
    const l = Math.hypot(m[0], m[1]) || 1;
    return [m[0] / l, m[1] / l];
  };
  tag('w', r0, r3, outward(r0, r3), prettyLen(size.width, units));
  tag('d', r2, r3, outward(r2, r3), prettyLen(size.depth, units));
  return (
    <g className="fs-resize fs-resize--ghost" aria-hidden="true" data-testid="resize-ghost">
      <polygon className="fs-resize__ghost" points={ring.map((p) => `${f1(p[0])},${f1(p[1])}`).join(' ')} />
      {device.clearances.map((c) => (
        <polygon key={c.name} className="fs-resize__clearance" points={c.ring.map((p) => toScreen(view, p)).map((p) => `${f1(p[0])},${f1(p[1])}`).join(' ')} />
      ))}
      {tags}
      {label === undefined ? null : (
        <g className="fs-resize__tag fs-resize__tag--hint" transform={`translate(${f1(centre[0])} ${f1(Math.max(...ring.map((p) => p[1])) + 44)})`}>
          <rect x={-90} y={-11} width={180} height={22} rx={6} />
          <text x={0} y={4} textAnchor="middle">{label}</text>
        </g>
      )}
    </g>
  );
}

/** The selected item, when it is one the editor resizes, on this level. */
export function resizableOn(level: LevelView, id: string | null): DeviceView | undefined {
  if (id === null) return undefined;
  const d = level.devices.find((x) => x.id === id);
  return d !== undefined && isResizable(d) ? d : undefined;
}

export type { HandleSide };
