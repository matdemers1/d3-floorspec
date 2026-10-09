import { boxFrame, categoryOf, doorSymbol, fixtureSymbol, type SymbolPart, type SymbolStroke } from '@floorspec/render2d';
import type { OpeningView, WallView } from './model';
import type { Viewport } from './store';
import { toScreen } from './viewport';
import type { DeviceView } from './systems/view';

/**
 * The plan symbols of doors, furniture and plumbing fixtures on the editor's canvas (FLR-T-12.27):
 * the geometry is @floorspec/render2d's (`plansymbols.ts`, FLR-T-12.24) — the same leaves, swings,
 * pockets, tracks and fixture outlines the SVG plan, MCP's render and the worker's PDF and DXF
 * drawings draw — and only the drawing is the canvas's own: each part a path in screen pixels,
 * classed by how it is drawn, so its colour is a design token (editor.css) in either theme.
 */

/** A door's symbol by its type's operation (Core 8.4): its leaves, swings, pocket, tracks or fold — nothing for a cased opening. */
export function doorParts(opening: OpeningView, wall: WallView): readonly SymbolPart[] {
  return doorSymbol({ start: opening.start, end: opening.end, hinge: opening.hinge, swing: opening.swing, operation: opening.operation }, { a: wall.left, b: wall.right }).parts;
}

/**
 * An FS_furniture or FS_plumbing element's outline by what it is — a bed and its pillows, a sofa, a
 * toilet's tank and bowl, a tub — on its box as the scene reads it (render2d's `boxFrame`). Null
 * when render2d knows no outline for it: it is drawn as its box, as it always was.
 */
export function fixtureParts(d: DeviceView): SymbolPart[] | null {
  const frame = boxFrame(d.element, d.footprint, d.placement ?? undefined);
  return fixtureSymbol({ extension: d.extension, collection: d.collection, category: categoryOf(d.element), frame });
}

const f1 = (n: number): string => n.toFixed(1);

/** A symbol part as SVG path data in the canvas's screen pixels. */
export function partPath(view: Viewport, part: SymbolPart): string {
  if (part.kind === 'arc') {
    const [hx, hy] = toScreen(view, part.centre);
    const [lx, ly] = toScreen(view, part.from);
    const [ox, oy] = toScreen(view, part.to);
    // Positive cross product in screen space (y down) is a clockwise turn: SVG's sweep-flag 1 — as render2d draws it.
    const sweep = (lx - hx) * (oy - hy) - (ly - hy) * (ox - hx) > 0 ? 1 : 0;
    const r = f1(part.radius * view.s);
    return `M${f1(lx)},${f1(ly)}A${r},${r} 0 0 ${String(sweep)} ${f1(ox)},${f1(oy)}`;
  }
  const d = part.pts.map((p, i) => {
    const [x, y] = toScreen(view, p);
    return `${i === 0 ? 'M' : 'L'}${f1(x)},${f1(y)}`;
  });
  return d.join('') + (part.closed ? 'Z' : '');
}

/** How each part of a door is drawn: the plan's leaf and swing, a dashed line above the cut, and a pocket in the wall's poché. */
export const DOOR_CLASS: Readonly<Record<SymbolStroke, string>> = {
  leaf: 'fs-plan2__leaf',
  swing: 'fs-plan2__swing',
  hidden: 'fs-plan2__hidden',
  inWall: 'fs-plan2__inwall',
  outline: 'fs-plan2__leaf',
  detail: 'fs-plan2__swing',
};

/** How each part of a fixture or furniture outline is drawn: its outline, the lines inside it, and what is above the cut. */
export const FIXTURE_CLASS: Readonly<Record<SymbolStroke, string>> = {
  leaf: 'fs-fixture__outline',
  swing: 'fs-fixture__detail',
  hidden: 'fs-fixture__hidden',
  inWall: 'fs-fixture__hidden',
  outline: 'fs-fixture__outline',
  detail: 'fs-fixture__detail',
};

/** Symbol parts as paths, one each, in the order render2d gives them. */
export function SymbolParts({ view, parts, classes }: { view: Viewport; parts: readonly SymbolPart[]; classes: Readonly<Record<SymbolStroke, string>> }) {
  return (
    <>
      {parts.map((part, i) => (
        <path key={i} className={classes[part.stroke]} data-stroke={part.stroke} d={partPath(view, part)} />
      ))}
    </>
  );
}
