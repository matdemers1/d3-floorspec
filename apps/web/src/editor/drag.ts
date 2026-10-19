import type { LevelView, OpeningView, Point, WallView } from './model';
import { alignMove, alignOpening, snapOpeningOn, type AlignedMove, type SnapSettings } from './snap';
import { dragHost, mountOf, type DeviceHover } from './systems/placement';
import type { DeviceView } from './systems/view';
import { boundsOfIds } from './arrange/shapes';
import { withRiders } from './arrange/riders';
import { frameOf } from './arrange/carry';

/**
 * Dragging an item or an opening, the one way for every view (FLR-T-18.18, FLR-T-14.8): the plan's
 * select tool and the 3D view's Edit in 3D both turn a pointer's travel into the same host — so the
 * same snaps, the same smart guides and the same op, whichever view the drag was made in.
 */

export interface DragOptions {
  /** The grid step (1 with the grid off). */
  grid: number;
  /** How near counts, base units. */
  tol: number;
  /** ⌘ or ⌥ held: no grid, no guides. */
  free: boolean;
  /** ⇧ held: only along the axis it has gone further on. */
  axis?: boolean;
  settings: SnapSettings;
  name: (id: string) => string;
}

export interface DeviceDrag {
  /** Where it would go; null where it cannot (a ceiling device outside a room). */
  hover: DeviceHover | null;
  /** The smart guide it lines up on, when one. */
  guide: AlignedMove | null;
  /** The move, as snapped and lined up. */
  d: Point;
}

/**
 * An item dragged by `d` from where it was grabbed: its host point moves by as much as the pointer
 * has, not to the pointer — so grabbed off-centre, it does not jump — by the grid (a wall mount's
 * offset snaps along its wall instead), lined up by the smart guides with walls and other items (not
 * with what it carries), and re-hosted the way it is hosted. `fallback` is where it starts when its
 * host has no point of its own.
 */
export function dragDevice(level: LevelView, device: DeviceView, by: Point, o: DragOptions & { fallback?: Point }): DeviceDrag {
  const origin = frameOf(level, device.host)?.point ?? device.placement?.point ?? o.fallback ?? null;
  let d: Point = by;
  if (o.axis === true) d = Math.abs(d[0]) >= Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
  const onWall = mountOf(device) === 'wall';
  if (!o.free && !onWall) d = [Math.round(d[0] / o.grid) * o.grid, Math.round(d[1] / o.grid) * o.grid];
  let guide: AlignedMove | null = null;
  const box = boundsOfIds(level, [device.id]);
  if (box !== null && !o.free) {
    guide = alignMove(level, box, d, { tol: o.tol, settings: o.settings, excludeItems: new Set(withRiders(level, [device.id])), name: o.name });
    d = o.axis === true ? [d[0] === 0 ? 0 : guide.d[0], d[1] === 0 ? 0 : guide.d[1]] : guide.d;
  }
  if (origin === null) return { hover: null, guide, d };
  const at: Point = [origin[0] + d[0], origin[1] + d[1]];
  const hover = dragHost(level, device, at, { grid: o.grid, tol: o.tol, pointGrid: 1 });
  return { hover: hover === null || hover.problem !== undefined ? null : hover, guide, d };
}

export interface OpeningDrag {
  offset: number;
  centered: boolean;
  guide: { guides: [Point, Point][]; label?: string } | null;
}

/** An opening slid along its wall to be centred on `pointer`: the wall's middle, the grid, and the smart guides. */
export function dragOpening(level: LevelView, wall: WallView, opening: OpeningView, pointer: Point, o: Omit<DragOptions, 'axis'>): OpeningDrag {
  const snap = snapOpeningOn(wall, opening.width, pointer, { tol: o.tol, grid: o.grid });
  // Smart guides: its centre or an edge in line with another opening's centre, a junction, an item.
  const aligned = snap.centered || o.free ? null : alignOpening(level, wall, { id: opening.id, offset: snap.offset, width: opening.width }, { tol: o.tol, settings: o.settings, name: o.name });
  return { offset: aligned?.offset ?? snap.offset, centered: aligned === null && snap.centered, guide: aligned };
}
