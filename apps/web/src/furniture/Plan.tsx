import type { EditorModel, LevelView, Point } from '../editor/model';
import type { Layers, Viewport } from '../editor/store';
import { toScreen } from '../editor/viewport';
import { facingVector, type DeviceView } from '../editor/systems/view';
import { assetHref } from './api';
import { filesOf, furnitureOn } from './view';
import { overlaps } from './placement';

/**
 * Furniture on the plan (FLR-T-8.3): each FS_furniture element drawn with its plan symbol
 * stretched over the footprint of its box, exactly as Core 12.6's table maps the image's corners —
 * top left at (min x, min y), top right at (min x, max y), bottom left at (max x, min y) of the
 * element's frame — so its front is along the image's bottom edge and it is never mirrored
 * (FS_furniture 3.3). The symbol is an SVG `<image>`: a browser draws it as a picture, runs nothing
 * in it and loads nothing it names. Under it the footprint is outlined, so an item whose symbol has
 * not arrived (or will not) is still where it is.
 *
 * An item in an FS_furniture interference lint (4.5: LINT-004, LINT-005) is outlined in the
 * warning tone, and with clearances shown, the envelope that is blocked is too. Its envelopes
 * themselves are drawn by the systems layer, with every other element's (systems/Symbols.tsx).
 */

const f1 = (n: number) => n.toFixed(2);
const f4 = (n: number) => n.toFixed(6);

type Json = Record<string, unknown>;
const boxOf = (d: DeviceView): { min: number[]; max: number[] } | null => {
  const b = (d.element['fallback'] as Json | undefined)?.['box'] as { min: number[]; max: number[] } | undefined;
  return b !== undefined && Array.isArray(b.min) && Array.isArray(b.max) ? b : null;
};

/** A point of an element's frame (Core 13.1) in plan: its placement, else its level's frame. */
export function frameOf(d: DeviceView): (x: number, y: number) => Point {
  const o = d.placement?.point ?? [0, 0];
  const u = d.placement === null ? ([1, 0] as Point) : facingVector(d.placement.facing);
  return (x, y) => [o[0] + x * u[0] - y * u[1], o[1] + x * u[1] + y * u[0]];
}

/**
 * Where an element's symbol image goes on screen (Core 12.6): its size in pixels — the footprint's
 * two sides — and the transform that takes that rectangle onto the footprint, corner to corner. The
 * image is laid out at its drawn size, so a browser rasterizes it sharp rather than scaling up a
 * one-pixel image; the transform then only turns it into place.
 */
export function symbolPlacement(view: Viewport, d: DeviceView): { width: number; height: number; transform: string } | null {
  const b = boxOf(d);
  if (b === null) return null;
  const at = frameOf(d);
  const [x0, y0, x1, y1] = [b.min[0] ?? 0, b.min[1] ?? 0, b.max[0] ?? 0, b.max[1] ?? 0];
  const tl = toScreen(view, at(x0, y0));
  const tr = toScreen(view, at(x0, y1));
  const bl = toScreen(view, at(x1, y0));
  const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  if (!(w > 0) || !(h > 0)) return null;
  const transform = `matrix(${f4((tr[0] - tl[0]) / w)} ${f4((tr[1] - tl[1]) / w)} ${f4((bl[0] - tl[0]) / h)} ${f4((bl[1] - tl[1]) / h)} ${f1(tl[0])} ${f1(tl[1])})`;
  return { width: w, height: h, transform };
}

/** The same as one matrix from the image's unit square, for a reader that wants the corners. */
export function symbolMatrix(view: Viewport, d: DeviceView): string | null {
  const p = symbolPlacement(view, d);
  if (p === null) return null;
  const [a, b, c, dd, e, f] = p.transform.slice(7, -1).split(' ').map(Number) as [number, number, number, number, number, number];
  return `matrix(${f1(a * p.width)} ${f1(b * p.width)} ${f1(c * p.height)} ${f1(dd * p.height)} ${f1(e)} ${f1(f)})`;
}

const pts = (view: Viewport, ring: readonly Point[]) => ring.map((p) => toScreen(view, p).map(f1).join(',')).join(' ');

/** Which furniture is in an interference lint (FS_furniture 4.5). */
export function blocked(model: EditorModel): Set<string> {
  const out = new Set<string>();
  for (const d of model.diagnostics) if (d.code === 'FS-FURN-LINT-004' || d.code === 'FS-FURN-LINT-005') for (const e of d.elements) out.add(e);
  return out;
}

/** The owners of envelopes that run into furniture (LINT-004): its message names the owner, its elements are sorted. */
export function blockedOwners(model: EditorModel): Set<string> {
  const out = new Set<string>();
  for (const d of model.diagnostics) {
    if (d.code !== 'FS-FURN-LINT-004') continue;
    const owner = /of (\S+) runs into/.exec(d.message)?.[1];
    if (owner !== undefined) out.add(owner);
  }
  return out;
}

export function FurnitureLayer({ view, level, model, layers, projectId }: { view: Viewport; level: LevelView; model: EditorModel; layers: Layers; projectId: string }) {
  if (layers.coreOnly || layers.furniture === false) return null;
  const items = furnitureOn(level);
  if (items.length === 0) return null;
  const warn = blocked(model);
  const owners = blockedOwners(model);
  return (
    <g className="fs-furn-layer" aria-hidden="true">
      {items.map((d) => {
        const symbol = filesOf(model.document, d.element).symbol;
        const placed = symbolPlacement(view, d);
        return (
          <g key={d.id} className={warn.has(d.id) ? 'fs-furn-item fs-furn-item--blocked' : 'fs-furn-item'} data-furniture={d.id}>
            <polygon className="fs-furn-item__fill" points={pts(view, d.footprint)} />
            {symbol !== null && placed !== null ? (
              <image className="fs-furn__symbol" href={assetHref(projectId, symbol.sha256)} x={0} y={0} width={f1(placed.width)} height={f1(placed.height)} preserveAspectRatio="none" transform={placed.transform} />
            ) : null}
            {/* The footprint's edge over the symbol: an item reads at any zoom, its symbol's own lines or not. */}
            <polygon className="fs-furn-item__outline" points={pts(view, d.footprint)} />
          </g>
        );
      })}
      {layers.clearances
        ? level.devices
            .filter((d) => owners.has(d.id))
            .flatMap((d) =>
              d.clearances
                // The envelope that something stands in, not every envelope of its owner.
                .filter((c) => items.some((o) => o.id !== d.id && overlaps(c.ring, o.footprint)))
                .map((c) => <polygon key={`${d.id}/${c.name}`} className="fs-clearance fs-clearance--blocked" data-blocked={`${d.id}/${c.name}`} points={pts(view, c.ring)} />),
            )
        : null}
    </g>
  );
}
