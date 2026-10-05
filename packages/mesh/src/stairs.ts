/**
 * Stairs (Core 0.3 and 0.4, chapter 17), from their derived steps (17.5, 17.7).
 *
 * Every tread and landing, in the order they are walked up, is a block of its outline from the top
 * of the piece two before it (the stair's bottom for the first two) up to its own top: two risers
 * deep, so consecutive pieces overlap by one riser along the edge they share and a flight is one
 * solid with a stepped soffit under it, never pieces that touch only along an edge. A flight's
 * treads are unioned by manifold-3d into one part; each landing is a part of its own.
 *
 * A winder stair's winders are treads like any other, so its two flights and the winders between
 * them are one solid; a spiral stair's treads are one solid too, wound round its centre column — a
 * cylinder of its column's radius, the space its treads leave (Core 17.7), or a slender pole where
 * they meet at the centre — from its bottom to its top. A winder or spiral stair whose steps are not
 * derived (read as a Core 0.3 reader reads it) is a placeholder: its box (17.4) as a block.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';
import { MeshBuilder, type P2 } from './builder.js';
import { scoped, type Kernel } from './kernel.js';
import type { RawPart } from './part.js';
import type { Box3 } from './types.js';

/** How many sides a spiral stair's column is drawn with: a mesh is not normative (Core 0.5), and 32 reads as round. */
const COLUMN_SIDES = 32;
/** The radius of the pole a spiral stair whose treads meet at its centre is drawn round: 1 in. */
const POLE = 32_512;

interface Piece {
  outline: P2[];
  lo: number;
  top: number;
}

function boxOf(pieces: readonly Piece[]): Box3 {
  const xs = pieces.flatMap((p) => p.outline.map((q) => q[0]));
  const ys = pieces.flatMap((p) => p.outline.map((q) => q[1]));
  return {
    min: [Math.min(...xs), Math.min(...ys), Math.min(...pieces.map((p) => p.lo))],
    max: [Math.max(...xs), Math.max(...ys), Math.max(...pieces.map((p) => p.top))],
  };
}

export function stairParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  const out: RawPart[] = [];
  const { Manifold } = kernel;
  for (const id of Object.keys(derived.stairs ?? {}).sort()) {
    const s = derived.stairs![id]!;
    const level = get(doc.stairs, id)!.level;
    if (!s.steps) {
      if (!want('stairBlock')) continue;
      const { min, max } = s.box;
      const b = new MeshBuilder(kernel);
      b.prism([[[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]]], min[2], max[2]);
      out.push({ kind: 'stairBlock', id, level, closed: true, placeholder: true, exact: b });
      continue;
    }
    const steps = s.steps;
    const pieces = steps.map((st, k): Piece & { landing: boolean } => ({
      outline: st.outline,
      lo: k >= 2 ? steps[k - 2]!.top : s.bottom,
      top: st.top,
      landing: st.landing === true,
    }));
    let flight: Piece[] = [];
    let flights = 0;
    let landings = 0;
    const flush = (): void => {
      if (!flight.length) return;
      flights++;
      if (want('stairFlight')) {
        const o = flight[0]!.outline[0]!;
        const origin = [o[0], o[1], s.bottom] as const;
        const manifold = scoped((keep) =>
          Manifold.union(
            flight.map((p) =>
              keep(keep(Manifold.extrude([p.outline.map((q): [number, number] => [q[0] - o[0], q[1] - o[1]])], p.top - p.lo)).translate(0, 0, p.lo - s.bottom)),
            ),
          ),
        );
        out.push({ kind: 'stairFlight', id, level, piece: `flight${flights}`, closed: true, manifold, origin, box: boxOf(flight) });
      }
      flight = [];
    };
    const st = get(doc.stairs, id)!;
    if (st.form?.kind === 'spiral' && s.centre !== undefined && want('stairColumn')) {
      const r = st.form.diameter / 2 - st.width;
      const radius = r > 0 ? r : POLE;
      const [cx, cy] = s.centre;
      const ring: P2[] = Array.from({ length: COLUMN_SIDES }, (_, i) => {
        const a = (2 * Math.PI * i) / COLUMN_SIDES;
        return [Math.round(cx + radius * Math.cos(a)), Math.round(cy + radius * Math.sin(a))];
      });
      const b = new MeshBuilder(kernel);
      b.prism([ring], s.bottom, s.top);
      out.push({ kind: 'stairColumn', id, level, piece: 'column', closed: true, exact: b });
    }
    for (const p of pieces) {
      if (!p.landing) {
        flight.push(p);
        continue;
      }
      flush();
      landings++;
      if (want('stairLanding')) {
        const b = new MeshBuilder(kernel);
        b.prism([p.outline], p.lo, p.top);
        out.push({ kind: 'stairLanding', id, level, piece: `landing${landings}`, closed: true, exact: b });
      }
    }
    flush();
  }
  return out;
}
