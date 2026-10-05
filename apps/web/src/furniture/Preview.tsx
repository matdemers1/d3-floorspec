import type { ClearanceEnvelope } from '@floorspec/engine';
import type { UnitSystem } from '../editor/units';
import type { Box } from './gltf';

/**
 * An item's plan symbol with its clearance envelopes, as the library's detail and the upload dialog
 * show it (the board's frame 14): drawn as Core 12.6 draws a symbol — the image stretched over the
 * footprint of the box, the item's front along the bottom edge — so image x is the frame's +y and
 * image y its +x, and each envelope is a box in the same frame. The symbol is an image element:
 * an SVG drawn this way runs no script and loads nothing, whatever it says.
 */

const MM = 1_280;
const IN = 32_512;

/** "36 × 30 × 70 in" or "900 × 700 × 1780 mm": width × depth × height (FS_furniture 3.1). */
export function sizeText(box: Box, units: UnitSystem): string {
  const w = box.max[1] - box.min[1];
  const d = box.max[0] - box.min[0];
  const h = box.max[2] - box.min[2];
  const n = (v: number) => String(Math.round(v / (units === 'metric' ? MM : IN)));
  return `${n(w)} × ${n(d)} × ${n(h)} ${units === 'metric' ? 'mm' : 'in'}`;
}

/** How far an envelope reaches beyond the box, along the side it is on: "36 in", "900 mm". */
export function reachText(box: Box, e: ClearanceEnvelope, units: UnitSystem): string {
  const reach = Math.max(e.max[0] - box.max[0], box.min[0] - e.min[0], e.max[1] - box.max[1], box.min[1] - e.min[1], 0);
  return `${String(Math.round(reach / (units === 'metric' ? MM : IN)))} ${units === 'metric' ? 'mm' : 'in'}`;
}

export function ClearancePreview({ box, clearances, symbol, label, units }: { box: Box; clearances: Record<string, ClearanceEnvelope>; symbol: string | null; label: string; units: UnitSystem }) {
  // Symbol space: x along the frame's +y, y along its +x (front at the bottom).
  const rects = Object.entries(clearances).map(([name, e]) => ({ name, e, x: e.min[1], y: e.min[0], w: e.max[1] - e.min[1], h: e.max[0] - e.min[0] }));
  const all = [{ x: box.min[1], y: box.min[0], w: box.max[1] - box.min[1], h: box.max[0] - box.min[0] }, ...rects];
  const minX = Math.min(...all.map((r) => r.x));
  const minY = Math.min(...all.map((r) => r.y));
  const maxX = Math.max(...all.map((r) => r.x + r.w));
  const maxY = Math.max(...all.map((r) => r.y + r.h));
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08;
  const vb = [minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad];
  const extent = Math.max(vb[2] ?? 1, vb[3] ?? 1);
  const stroke = extent / 260;
  const font = extent / 15;
  return (
    <svg className="fs-furn-preview" viewBox={vb.map((v) => v.toFixed(0)).join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label}>
      {rects.map((r) => (
        <g key={r.name}>
          <rect className="fs-furn-preview__envelope" x={r.x} y={r.y} width={r.w} height={r.h} strokeWidth={stroke} strokeDasharray={`${String(stroke * 4)} ${String(stroke * 3)}`} />
        </g>
      ))}
      <rect className="fs-furn-preview__box" x={box.min[1]} y={box.min[0]} width={box.max[1] - box.min[1]} height={box.max[0] - box.min[0]} strokeWidth={stroke} />
      {symbol !== null ? (
        <image className="fs-furn__symbol" href={symbol} x={box.min[1]} y={box.min[0]} width={box.max[1] - box.min[1]} height={box.max[0] - box.min[0]} preserveAspectRatio="none" />
      ) : null}
      {rects.map((r) => (
        <text key={r.name} className="fs-furn-preview__label" x={r.x + r.w / 2} y={r.y + r.h / 2} fontSize={font} textAnchor="middle" dominantBaseline="middle">
          {r.name} · {reachText(box, r.e, units)}
        </text>
      ))}
    </svg>
  );
}
